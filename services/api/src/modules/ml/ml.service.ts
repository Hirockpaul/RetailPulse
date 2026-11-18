import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import type { RequestContext } from '../../core/http/request-context';
import { MlRepository } from './ml.repository';
import type { ModelDecision } from './ml.schemas';

const ACTIVATION_WAPE_GAIN = 0.005;

@Injectable()
export class MlService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: MlRepository,
  ) {}

  async overview() {
    const [models, history] = await Promise.all([this.repo.models(), this.repo.history()]);
    return { activationWapeGain: ACTIVATION_WAPE_GAIN, models, history };
  }

  activate(id: string, body: ModelDecision, ctx: RequestContext) {
    return this.change(id, body, ctx, 'ACTIVATE');
  }

  rollback(id: string, body: ModelDecision, ctx: RequestContext) {
    return this.change(id, body, ctx, 'ROLLBACK');
  }

  private async change(
    id: string,
    body: ModelDecision,
    ctx: RequestContext,
    action: 'ACTIVATE' | 'ROLLBACK',
  ) {
    await this.db.transaction(async (client) => {
      await this.repo.lockRegistry(client);
      const target = await this.repo.lockedModel(client, id);
      const active = await this.repo.active(client);
      if (!target) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Model version not found.' });
      }
      if (!active) {
        throw new ConflictException({
          code: 'MODEL_REGISTRY_NOT_BOOTSTRAPPED',
          message: 'Run a successful forecast once before changing the active model.',
        });
      }
      if (action === 'ACTIVATE' && target.status !== 'ELIGIBLE') {
        throw invalidState('Only an ELIGIBLE model can be activated.');
      }
      if (action === 'ROLLBACK') {
        const latest = await this.repo.latestActivation(client);
        if (
          target.status !== 'RETIRED' ||
          latest?.fromModelId !== target.id ||
          latest.toModelId !== active.id
        ) {
          throw invalidState('Rollback can only restore the immediately previous active model.');
        }
      }
      if (!hasArtifact(target) || !hasArtifact(active)) {
        throw invalidState(
          'Both model versions need persisted artifacts. Run a successful forecast before changing policy.',
        );
      }
      await this.repo.setStatus(client, active.id, 'RETIRED');
      await this.repo.setStatus(client, target.id, 'ACTIVE');
      await this.repo.insertActivation(
        client,
        action,
        active.id,
        target.id,
        ctx.user.id,
        body.reason,
      );
    });
    return this.overview();
  }
}

const invalidState = (message: string) =>
  new ConflictException({ code: 'INVALID_MODEL_STATE', message });

const hasArtifact = (model: {
  artifactPath: string | null;
  artifactSha256: string | null;
  artifactSchemaVersion: number | null;
}) => Boolean(model.artifactPath && model.artifactSha256 && model.artifactSchemaVersion);
