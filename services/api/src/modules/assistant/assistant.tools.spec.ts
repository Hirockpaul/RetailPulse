import type { AuthUser } from '../../core/auth/auth.types';
import type { AnomaliesService } from '../anomalies/anomalies.service';
import type { OverviewService } from '../overview/overview.service';
import type { ReplenishmentService } from '../replenishment/replenishment.service';
import { AssistantTools } from './assistant.tools';

const user: AuthUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'manager@example.test',
  displayName: 'Manager',
  role: 'STORE_MANAGER',
  locationIds: ['00000000-0000-0000-0000-000000000010'],
};

describe('AssistantTools', () => {
  it('passes the signed-in user through every read and never invokes mutation methods', async () => {
    const overview = {
      get: jest.fn().mockResolvedValue({
        asOf: new Date('2026-11-19T10:00:00Z'),
        storeCount: 1,
        stock: { positions: 2, atRiskTop: [], excessTop: [] },
        recommendations: { pending: 1 },
        alerts: { open: 1 },
        freshness: { lastMovementAt: null, forecast: null, eventsWaiting: 0 },
        controlTower: {
          kpis: { onHand: 12 },
          risks: { atRisk7: 1, suppliersAtRisk: [] },
          charts: {
            storeHealth: [
              {
                locationId: user.locationIds[0],
                locationCode: 'STR-01',
                outOfStock: 0,
              },
            ],
          },
        },
      }),
      locations: jest
        .fn()
        .mockResolvedValue([
          { locationId: user.locationIds[0], locationCode: 'STR-01', onHand: 12 },
        ]),
    };
    const anomalies = {
      list: jest.fn().mockResolvedValue({ data: [], page: 1, pageSize: 10, total: 0 }),
      review: jest.fn(() => {
        throw new Error('write called');
      }),
    };
    const replenishment = {
      list: jest.fn().mockResolvedValue({ data: [], page: 1, pageSize: 10, total: 0 }),
      approve: jest.fn(() => {
        throw new Error('write called');
      }),
      reject: jest.fn(() => {
        throw new Error('write called');
      }),
    };
    const tools = new AssistantTools(
      overview as unknown as OverviewService,
      anomalies as unknown as AnomaliesService,
      replenishment as unknown as ReplenishmentService,
    );

    await tools.execute('get_control_tower', '{}', user);
    await tools.execute('get_location_health', '{}', user);
    await tools.execute('get_open_anomalies', '{"severity":"HIGH"}', user);
    await tools.execute(
      'get_pending_recommendations',
      '{"risk":"CRITICAL","action":"TRANSFER"}',
      user,
    );

    expect(overview.get).toHaveBeenCalledWith(user);
    expect(overview.locations).toHaveBeenCalledWith(user);
    expect(anomalies.list).toHaveBeenCalledWith(expect.any(Object), user);
    expect(replenishment.list).toHaveBeenCalledWith(expect.any(Object), user);
    expect(anomalies.review).not.toHaveBeenCalled();
    expect(replenishment.approve).not.toHaveBeenCalled();
    expect(replenishment.reject).not.toHaveBeenCalled();
  });

  it('rejects unknown tools and malformed arguments without reading data', async () => {
    const overview = { get: jest.fn(), locations: jest.fn() };
    const anomalies = { list: jest.fn() };
    const replenishment = { list: jest.fn() };
    const tools = new AssistantTools(
      overview as unknown as OverviewService,
      anomalies as unknown as AnomaliesService,
      replenishment as unknown as ReplenishmentService,
    );

    await expect(tools.execute('change_stock', '{}', user)).rejects.toThrow('unknown_tool');
    await expect(
      tools.execute('get_open_anomalies', '{"locationId":"other"}', user),
    ).rejects.toBeDefined();
    expect(overview.get).not.toHaveBeenCalled();
    expect(anomalies.list).not.toHaveBeenCalled();
    expect(replenishment.list).not.toHaveBeenCalled();
  });
});
