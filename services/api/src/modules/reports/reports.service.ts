import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  UnprocessableEntityException,
} from '@nestjs/common';
import { accessibleLocationIds, assertLocationAccess } from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import { AiService } from '../../core/ai/ai.service';
import { ENV, type Env } from '../../core/config/env';
import type { Page } from '../../core/http/query';
import { OverviewService } from '../overview/overview.service';
import { csvFileName, toCsv } from './reports.csv';
import { dueScheduled, periodFor } from './reports.period';
import { ReportsRepository } from './reports.repository';
import type {
  GenerateReport,
  ListReportsQuery,
  ReportContent,
  ReportDetail,
  ReportKind,
  ReportSummary,
  ReportWords,
} from './reports.schemas';
import { reportWords } from './reports.words';

const HOURLY_MS = 60 * 60 * 1000;

const networkForbidden = () =>
  new ForbiddenException({
    code: 'FORBIDDEN',
    message: 'Store managers can only use reports for their own stores.',
  });

/**
 * Reports (V2 4c-1): frozen snapshots of one period and scope — sales, movements and work from the
 * ledger and work tables, plus the Control Tower figures at generation time. Generated on request
 * and by an hourly schedule (yesterday's network DAILY report; on Mondays last week's WEEKLY).
 */
@Injectable()
export class ReportsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReportsService.name);
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<unknown> | undefined;

  constructor(
    private readonly repo: ReportsRepository,
    private readonly overview: OverviewService,
    @Inject(ENV) private readonly env: Env,
    private readonly ai: AiService,
  ) {}

  onApplicationBootstrap() {
    if (this.env.HOUSEKEEPING_ENABLED) this.schedule(3 * 60 * 1000);
  }

  async onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.current;
  }

  private schedule(delayMs: number) {
    this.timer = setTimeout(() => {
      this.current = this.runSchedule()
        .catch((err) =>
          this.logger.warn(`Scheduled reports failed: ${err instanceof Error ? err.message : err}`),
        )
        .finally(() => {
          this.current = undefined;
          if (this.timer) this.schedule(HOURLY_MS);
        });
    }, delayMs);
    this.timer.unref();
  }

  /** Create any scheduled report that is due and missing. Returns how many were created. */
  async runSchedule(): Promise<number> {
    const yesterday = await this.repo.yesterdayUtc();
    let created = 0;
    for (const due of dueScheduled(yesterday)) {
      if (await this.repo.scheduledExists(due.kind, due.start)) continue;
      const id = await this.build(due.kind, due.start, due.end, null, null, 'SCHEDULED');
      if (id) created++;
    }
    return created;
  }

  async generate(body: GenerateReport, user: AuthUser): Promise<ReportDetail> {
    if (body.locationId) assertLocationAccess(user, body.locationId);
    else if (accessibleLocationIds(user) !== null) throw networkForbidden();
    const yesterday = await this.repo.yesterdayUtc();
    const end = body.periodEnd ?? yesterday;
    if (end > yesterday) {
      throw new UnprocessableEntityException({
        code: 'PERIOD_NOT_COMPLETE',
        message: `A report can end on ${yesterday} at the latest: later days are not complete yet.`,
      });
    }
    const { start } = periodFor(body.kind, end);
    const id = await this.build(body.kind, start, end, body.locationId ?? null, user.id, 'MANUAL');
    return (await this.repo.find(id!))!;
  }

  private async build(
    kind: ReportKind,
    start: string,
    end: string,
    locationId: string | null,
    userId: string | null,
    trigger: 'MANUAL' | 'SCHEDULED',
  ): Promise<string | null> {
    const started = performance.now();
    const scope = locationId ? [locationId] : null;
    const location = locationId ? await this.repo.location(locationId) : null;
    if (locationId && !location) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Location not found.' });
    }
    const args: [string, string, string[] | null] = [start, end, scope];
    const [sales, byStore, topProducts, movements, work, overview] = await Promise.all([
      this.repo.sales(args),
      this.repo.salesByStore(args),
      this.repo.topProducts(args),
      this.repo.movements(args),
      this.repo.work(args),
      this.overview.forScope(scope),
    ]);
    const hasForecast = overview.freshness.forecast !== null;
    const ct = overview.controlTower;
    const content: ReportContent = {
      kind,
      periodStart: start,
      periodEnd: end,
      scope: location,
      generatedAt: new Date().toISOString(),
      dataLabel: 'SYNTHETIC',
      sales: { ...sales, byStore, topProducts },
      movements,
      work,
      stockAtGeneration: {
        asOf: new Date(overview.asOf).toISOString(),
        positions: overview.stock.positions,
        onHand: ct.kpis.onHand,
        available: ct.kpis.available,
        valueAtCost: ct.kpis.valueAtCost,
        outOfStock: overview.stock.outOfStock,
        atRisk7: hasForecast ? ct.risks.atRisk7 : null,
        atRisk14: hasForecast ? ct.risks.atRisk14 : null,
        excessPositions: hasForecast ? ct.risks.excess.positions : null,
        excessValueAtCost: hasForecast ? ct.risks.excess.valueAtCost : null,
      },
    };
    return this.repo.save({
      kind,
      periodStart: start,
      periodEnd: end,
      locationId,
      trigger,
      generatedBy: userId,
      durationMs: Math.round(performance.now() - started),
      content,
    });
  }

  async list(q: ListReportsQuery, user: AuthUser): Promise<Page<ReportSummary>> {
    if (q.locationId) assertLocationAccess(user, q.locationId);
    const { rows, total } = await this.repo.list(q, accessibleLocationIds(user));
    return { data: rows, page: q.page, pageSize: q.pageSize, total };
  }

  async get(id: string, user: AuthUser): Promise<ReportDetail> {
    const report = await this.repo.find(id);
    if (!report) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Report not found.' });
    if (report.locationId) assertLocationAccess(user, report.locationId);
    else if (accessibleLocationIds(user) !== null) throw networkForbidden();
    return report;
  }

  async csv(id: string, user: AuthUser): Promise<{ fileName: string; body: string }> {
    const report = await this.get(id, user);
    return { fileName: csvFileName(report.content), body: toCsv(report.content) };
  }

  async summarizeInWords(id: string, user: AuthUser): Promise<ReportWords> {
    const report = await this.get(id, user);
    const prepared = reportWords(report.content);
    const result = await this.ai.explain({
      userId: user.id,
      feature: 'report',
      facts: prepared.facts,
      template: prepared.template,
    });
    return { source: result.source, provider: result.provider, claims: result.answer.claims };
  }
}
