import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { assertLocationAccess } from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import { ENV, type Env } from '../../core/config/env';
import { DatabaseService } from '../../core/database/database.service';
import type { Page } from '../../core/http/query';
import { classify, type ItemInput } from './classifications.calc';
import { ABC_MEANING, CLASSIFICATION as C, POLICIES, XYZ_MEANING } from './classifications.config';
import { ClassificationsRepository, type WeeklyRow } from './classifications.repository';
import type {
  ClassificationSummary,
  ClassifiedItem,
  ListClassificationsQuery,
  ScopeQuery,
} from './classifications.schemas';

const DAY_MS = 86_400_000;
const DAILY_MS = 24 * 60 * 60 * 1000;
const FRESH_ENOUGH_MS = 20 * 60 * 60 * 1000;

/**
 * ABC/XYZ classification: which products carry the value (ABC) and how predictable their demand
 * is (XYZ), network-wide and per store. Advice for stocking policy only.
 * Runs on demand and once a day (with the other background jobs: HOUSEKEEPING_ENABLED).
 */
@Injectable()
export class ClassificationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ClassificationsService.name);
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<unknown> | undefined;

  constructor(
    private readonly repo: ClassificationsRepository,
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    if (this.env.HOUSEKEEPING_ENABLED) this.schedule(2 * 60 * 1000);
  }

  async onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.current;
  }

  private schedule(delayMs: number) {
    this.timer = setTimeout(() => {
      this.current = this.dailyRun().finally(() => {
        this.current = undefined;
        if (this.timer) this.schedule(DAILY_MS);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async dailyRun() {
    try {
      const latest = await this.repo.latestRun();
      if (latest && Date.now() - new Date(latest.calculatedAt).getTime() < FRESH_ENOUGH_MS) return;
      await this.recalculate(null);
    } catch (err) {
      this.logger.warn(`Daily classification failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Classify the network and every store from the sales history; returns the network summary. */
  async recalculate(user: AuthUser | null): Promise<ClassificationSummary> {
    const window = await this.repo.window(C.windowWeeks);
    if (!window) {
      throw new ConflictException({
        code: 'NO_SALES_HISTORY',
        message: 'There is no sales history to classify yet. Run `npm run forecast:history`.',
      });
    }
    const [weekly, firsts, costs, stores] = await Promise.all([
      this.repo.weekly(window.start, window.end),
      this.repo.firstDays(),
      this.repo.unitCosts(),
      this.repo.stores(),
    ]);
    const end = Date.parse(`${window.end}T00:00:00Z`);
    const weeksExisting = (first: string) =>
      Math.min(
        C.windowWeeks,
        Math.floor((end - Date.parse(`${first}T00:00:00Z`)) / DAY_MS / 7) + 1,
      );

    const series = new Map<string, number[]>(); // product:location → weekly units, oldest first
    const existed = new Map<string, number>();
    for (const f of firsts) existed.set(`${f.productId}:${f.locationId}`, weeksExisting(f.first));
    const add = (r: WeeklyRow) => {
      const key = `${r.productId}:${r.locationId}`;
      const n = existed.get(key) ?? C.windowWeeks;
      if (!series.has(key)) series.set(key, Array(n).fill(0));
      const arr = series.get(key)!;
      const idx = arr.length - 1 - r.weeksAgo;
      if (idx >= 0) arr[idx] += r.units;
    };
    weekly.forEach(add);

    const items: {
      productId: string;
      locationId: string | null;
      r: ReturnType<typeof classify>[number];
    }[] = [];
    // Per store.
    for (const store of stores) {
      const inputs: ItemInput[] = [];
      for (const [productId, cost] of costs) {
        const key = `${productId}:${store.id}`;
        const weeks =
          series.get(key) ?? (existed.has(key) ? Array(existed.get(key)).fill(0) : null);
        if (weeks) inputs.push({ key: productId, weekly: weeks, unitCost: cost });
      }
      for (const r of classify(inputs)) items.push({ productId: r.key, locationId: store.id, r });
    }
    // Network: the sum of the stores, over the longest any store has had the product.
    const network: ItemInput[] = [];
    for (const [productId, cost] of costs) {
      const perStore = stores
        .map((s) => series.get(`${productId}:${s.id}`))
        .filter((w): w is number[] => Boolean(w));
      if (perStore.length === 0) continue;
      const n = Math.max(...perStore.map((w) => w.length));
      const total = Array(n).fill(0);
      for (const w of perStore) w.forEach((v, i) => (total[n - w.length + i] += v));
      network.push({ key: productId, weekly: total, unitCost: cost });
    }
    for (const r of classify(network)) items.push({ productId: r.key, locationId: null, r });

    await this.db.transaction(async (client) => {
      await this.repo.saveRun(client, { ...window, triggeredBy: user?.id ?? null }, items);
      await this.repo.pruneRuns(client, C.keepRuns);
    });
    return this.summary({}, user);
  }

  /**
   * The latest run's class of each product at each store (`productId:locationId` → 'AX' … 'NEW'),
   * for service levels in replenishment. Empty if nothing has been classified yet.
   */
  async latestStoreClasses(): Promise<{ runId: string | null; classes: Map<string, string> }> {
    const run = await this.repo.latestRun();
    if (!run) return { runId: null, classes: new Map() };
    return { runId: run.id, classes: await this.repo.storeClasses(run.id) };
  }

  async summary(scope: ScopeQuery, user: AuthUser | null): Promise<ClassificationSummary> {
    if (scope.locationId && user) assertLocationAccess(user, scope.locationId);
    const run = await this.repo.latestRun();
    const stores = scope.locationId ? await this.repo.stores() : [];
    return {
      run,
      scope: {
        locationId: scope.locationId ?? null,
        locationCode: stores.find((s) => s.id === scope.locationId)?.code ?? null,
      },
      cells: run ? await this.repo.cells(run.id, scope.locationId ?? null) : [],
      rules: {
        windowWeeks: C.windowWeeks,
        minWeeks: C.minWeeks,
        abc: { ...C.abc },
        xyz: { ...C.xyz },
        intermittentAdi: C.intermittentAdi,
      },
      meanings: { abc: ABC_MEANING, xyz: XYZ_MEANING },
      policies: POLICIES,
    };
  }

  async list(q: ListClassificationsQuery, user: AuthUser): Promise<Page<ClassifiedItem>> {
    if (q.locationId) assertLocationAccess(user, q.locationId);
    const run = await this.repo.latestRun();
    if (!run) return { data: [], page: q.page, pageSize: q.pageSize, total: 0 };
    const { rows, total } = await this.repo.list(run.id, q);
    return { data: rows, page: q.page, pageSize: q.pageSize, total };
  }
}
