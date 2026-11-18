import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import type { LockedModel, ModelActivation, ModelStatus, ModelVersion } from './ml.schemas';

@Injectable()
export class MlRepository {
  constructor(private readonly db: DatabaseService) {}

  async models(): Promise<ModelVersion[]> {
    const { rows } = await this.db.query<ModelVersion>(
      `SELECT m.id, m.name, m.version, m.kind, m.description, m.status, m.params,
              m.artifact_path AS "artifactPath", m.artifact_sha256 AS "artifactSha256",
              m.artifact_schema_version AS "artifactSchemaVersion",
              m.artifact_created_at AS "artifactCreatedAt",
              m.training_start::text AS "trainingStart", m.training_end::text AS "trainingEnd",
              m.feature_config AS "featureConfig", m.latest_run_id AS "latestRunId",
              m.eligibility_reason AS "eligibilityReason", m.evaluated_at AS "evaluatedAt",
              m.created_at AS "createdAt", v.wape::float8 AS "validationWape",
              t.wape::float8 AS "testWape"
         FROM forecast.model_versions m
         LEFT JOIN forecast.model_metrics v ON v.run_id = m.latest_run_id
              AND v.model = m.name AND v.split = 'validation'
         LEFT JOIN forecast.model_metrics t ON t.run_id = m.latest_run_id
              AND t.model = m.name AND t.split = 'test'
        ORDER BY (m.status = 'ACTIVE') DESC, m.kind, m.name, m.version DESC`,
    );
    return rows;
  }

  async history(): Promise<ModelActivation[]> {
    const { rows } = await this.db.query<ModelActivation>(
      `SELECT a.id, a.action, a.from_model_id AS "fromModelId", fm.name AS "fromModel",
              a.to_model_id AS "toModelId", tm.name AS "toModel", a.actor_id AS "actorId",
              u.display_name AS "actorName", a.reason, a.created_at AS "createdAt"
         FROM forecast.model_activations a
         LEFT JOIN forecast.model_versions fm ON fm.id = a.from_model_id
         JOIN forecast.model_versions tm ON tm.id = a.to_model_id
         LEFT JOIN users u ON u.id = a.actor_id
        ORDER BY a.created_at DESC, a.id DESC LIMIT 100`,
    );
    return rows;
  }

  lockRegistry(client: PoolClient) {
    return client.query(`SELECT pg_advisory_xact_lock(hashtext('retailpulse:model-registry'))`);
  }

  async lockedModel(client: PoolClient, id: string): Promise<LockedModel | null> {
    const { rows } = await client.query<LockedModel>(
      `SELECT id, name, version, kind, status, artifact_path AS "artifactPath",
              artifact_sha256 AS "artifactSha256",
              artifact_schema_version AS "artifactSchemaVersion" FROM forecast.model_versions
        WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async active(client: PoolClient): Promise<LockedModel | null> {
    const { rows } = await client.query<LockedModel>(
      `SELECT id, name, version, kind, status, artifact_path AS "artifactPath",
              artifact_sha256 AS "artifactSha256",
              artifact_schema_version AS "artifactSchemaVersion" FROM forecast.model_versions
        WHERE status = 'ACTIVE' FOR UPDATE`,
    );
    return rows[0] ?? null;
  }

  async latestActivation(client: PoolClient): Promise<ModelActivation | null> {
    const { rows } = await client.query<ModelActivation>(
      `SELECT id, action, from_model_id AS "fromModelId", to_model_id AS "toModelId",
              actor_id AS "actorId", reason, created_at AS "createdAt",
              NULL::text AS "fromModel", ''::text AS "toModel", NULL::text AS "actorName"
         FROM forecast.model_activations ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`,
    );
    return rows[0] ?? null;
  }

  setStatus(client: PoolClient, id: string, status: ModelStatus) {
    return client.query(`UPDATE forecast.model_versions SET status = $2 WHERE id = $1`, [
      id,
      status,
    ]);
  }

  insertActivation(
    client: PoolClient,
    action: 'ACTIVATE' | 'ROLLBACK',
    fromModelId: string,
    toModelId: string,
    actorId: string,
    reason: string,
  ) {
    return client.query(
      `INSERT INTO forecast.model_activations
         (action, from_model_id, to_model_id, actor_id, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [action, fromModelId, toModelId, actorId, reason],
    );
  }
}
