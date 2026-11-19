import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AiService } from '../../core/ai/ai.service';
import {
  accessibleLocationIds,
  assertLocationAccess,
  canAccessLocation,
} from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import { WRITE_ROLES } from '../../core/auth/roles';
import { DatabaseService } from '../../core/database/database.service';
import type { Page } from '../../core/http/query';
import type { RequestContext } from '../../core/http/request-context';
import { OPERATIONS_RULES as R } from './anomalies.config';
import { AnomaliesRepository } from './anomalies.repository';
import { frequentAdjustments, highReturnRate, largeWriteOff } from './anomalies.rules';
import {
  type AnomalyDetail,
  type AnomalyFinding,
  type AnomalyWords,
  type ListAnomaliesQuery,
  type ReviewBody,
  TRANSITIONS,
} from './anomalies.schemas';
import { anomalyWords } from './anomalies.words';

interface MovementPayload {
  ledgerId: string;
  productId: string;
  locationId: string;
  movementType: string;
  onHandDelta: number;
  onHandAfter: number;
}

/**
 * Unusual sales (found by the forecasting service) and unusual adjustments/returns (found here,
 * from stock-movement events), and the review workflow people use to handle them.
 * Nothing here changes stock: if a finding is confirmed, the fix is a normal, audited movement.
 */
@Injectable()
export class AnomaliesService {
  constructor(
    private readonly repo: AnomaliesRepository,
    private readonly db: DatabaseService,
    private readonly ai: AiService,
  ) {}

  async list(q: ListAnomaliesQuery, user: AuthUser): Promise<Page<AnomalyFinding>> {
    if (q.locationId) assertLocationAccess(user, q.locationId);
    const { rows, total } = await this.repo.list(q, accessibleLocationIds(user));
    return { data: rows, page: q.page, pageSize: q.pageSize, total };
  }

  async get(id: string, user: AuthUser): Promise<AnomalyDetail> {
    const finding = await this.repo.find(id);
    if (!finding) throw notFound();
    assertLocationAccess(user, finding.locationId);
    return this.withHistory(finding, user);
  }

  /** Reword this store-scoped finding without sending review notes or raw detector text. */
  async explainInWords(id: string, ctx: RequestContext): Promise<AnomalyWords> {
    const finding = await this.repo.find(id);
    if (!finding) throw notFound();
    assertLocationAccess(ctx.user, finding.locationId);
    const prepared = anomalyWords(finding);
    const result = await this.ai.explain({
      userId: ctx.user.id,
      feature: 'anomaly',
      facts: prepared.facts,
      template: prepared.template,
    });
    return { source: result.source, claims: result.answer.claims };
  }

  /** Move a finding one step in its review (NEW → INVESTIGATING → CONFIRMED → RESOLVED, …). */
  async review(id: string, body: ReviewBody, ctx: RequestContext): Promise<AnomalyDetail> {
    const finding = await this.repo.find(id);
    if (!finding) throw notFound();
    assertLocationAccess(ctx.user, finding.locationId);

    await this.db
      .transaction(async (client) => {
        const current = await this.repo.lockReview(client, id);
        const from = current?.status ?? 'NEW';
        if (!TRANSITIONS[from].includes(body.status)) throw invalidStep(from, body.status);
        const reviewId = current
          ? (await this.repo.updateReview(client, current.id, body.status, ctx.user.id), current.id)
          : await this.repo.createReview(client, id, finding.source, body.status, ctx.user.id);
        await this.repo.addEvent(
          client,
          reviewId,
          from,
          body.status,
          body.note ?? null,
          ctx.user.id,
        );
      })
      .catch((err: { code?: string }) => {
        // 23505: someone else made the first decision at the same moment.
        // 23514: the database refused the step (same rule as TRANSITIONS).
        if (err?.code === '23505' || err?.code === '23514') {
          throw new ConflictException({
            code: 'INVALID_STATE_TRANSITION',
            message: 'This finding was just reviewed by someone else. Reload and try again.',
          });
        }
        throw err;
      });

    const updated = await this.repo.find(id);
    return this.withHistory(updated as AnomalyFinding, ctx.user);
  }

  /**
   * Event consumer entry point: apply the operational rules after a stock movement, inside the
   * event's transaction. Judges the ledger as it stands (counts in a window), so a late or
   * repeated event cannot create a second finding for the same burst.
   */
  async evaluateMovement(client: PoolClient, m: MovementPayload, eventId: string): Promise<void> {
    if (m.movementType !== 'ADJUSTMENT' && m.movementType !== 'RETURN') return;
    const day = await this.repo.ledgerDay(client, m.ledgerId);
    if (!day) return; // ledger row not found: nothing to judge
    const store = (f: Parameters<AnomaliesRepository['insertOperational']>[1], days: number) =>
      this.repo.insertOperational(client, f, m.productId, m.locationId, day, days, eventId);

    if (m.movementType === 'ADJUSTMENT' && m.onHandDelta < 0) {
      const writeOff = largeWriteOff(m.onHandDelta, m.onHandAfter);
      if (writeOff) await store(writeOff, 1);
      const count = await this.repo.negativeAdjustments(
        client,
        m.productId,
        m.locationId,
        day,
        R.frequentWindowDays,
      );
      const frequent = frequentAdjustments(count);
      if (frequent) await store(frequent, R.frequentWindowDays);
    }
    if (m.movementType === 'RETURN') {
      const { returns, sales } = await this.repo.returnsAndSales(
        client,
        m.productId,
        m.locationId,
        day,
        R.returnWindowDays,
      );
      const rate = highReturnRate(returns, sales);
      if (rate) await store(rate, R.returnWindowDays);
    }
  }

  private async withHistory(finding: AnomalyFinding, user: AuthUser): Promise<AnomalyDetail> {
    const mayReview =
      (WRITE_ROLES as string[]).includes(user.role) && canAccessLocation(user, finding.locationId);
    return {
      ...finding,
      history: await this.repo.history(finding.id),
      nextSteps: mayReview ? [...TRANSITIONS[finding.status]] : [],
    };
  }
}

const notFound = () =>
  new NotFoundException({ code: 'NOT_FOUND', message: 'Anomaly finding not found.' });

const invalidStep = (from: string, to: string) =>
  new ConflictException({
    code: 'INVALID_STATE_TRANSITION',
    message: `A finding that is ${from.toLowerCase()} cannot become ${to.toLowerCase()}.`,
  });
