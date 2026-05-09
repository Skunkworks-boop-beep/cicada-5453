import { describe, it, expect } from 'vitest';
import type { BrokerConfig } from '../../core/types';
import { hydrateBrokers, SUPPORTED_BROKER_TYPES } from './brokerHydration';

const DEFAULTS: BrokerConfig[] = [
  { id: 'broker-mt5', name: 'MT5', type: 'mt5', status: 'disconnected', config: {}, order: 0 },
];

describe('hydrateBrokers', () => {
  it('returns defaults when persisted is empty', () => {
    expect(hydrateBrokers([], DEFAULTS)).toHaveLength(1);
    expect(hydrateBrokers(null, DEFAULTS)).toHaveLength(1);
    expect(hydrateBrokers(undefined, DEFAULTS)).toHaveLength(1);
  });

  it('drops deprecated broker types (Stage 7 migration)', () => {
    const persisted: BrokerConfig[] = [
      { id: 'broker-deriv', name: 'Deriv', type: 'deriv_api' as never, status: 'error', config: {}, order: 0 },
      { id: 'broker-exness-api', name: 'eXness', type: 'exness_api' as never, status: 'disconnected', config: {}, order: 1 },
      { id: 'broker-mt5', name: 'MT5', type: 'mt5', status: 'connected', config: {}, order: 2 },
    ];
    const out = hydrateBrokers(persisted, DEFAULTS);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('mt5');
  });

  it('merges persisted state into the matching default row', () => {
    const persisted: BrokerConfig[] = [
      { id: 'broker-mt5', name: 'MT5', type: 'mt5', status: 'connected', config: { login: '99999' }, order: 0 },
    ];
    const out = hydrateBrokers(persisted, DEFAULTS);
    expect(out[0]!.status).toBe('connected');
    expect(out[0]!.config.login).toBe('99999');
  });

  it('resets stuck connecting status on reload', () => {
    const persisted: BrokerConfig[] = [
      { id: 'broker-mt5', name: 'MT5', type: 'mt5', status: 'connecting', config: {}, order: 0 },
    ];
    const out = hydrateBrokers(persisted, DEFAULTS);
    expect(out[0]!.status).toBe('disconnected');
  });

  it('preserves operator-added brokers if they have a live type', () => {
    const persisted: BrokerConfig[] = [
      { id: 'broker-custom', name: 'Custom MT5', type: 'mt5', status: 'connected', config: {}, order: 5 },
    ];
    const out = hydrateBrokers(persisted, DEFAULTS);
    expect(out).toHaveLength(2);
    expect(out.find((b) => b.id === 'broker-custom')).toBeDefined();
  });

  it('orders by .order field', () => {
    const persisted: BrokerConfig[] = [
      { id: 'a', name: 'A', type: 'mt5', status: 'disconnected', config: {}, order: 5 },
      { id: 'b', name: 'B', type: 'mt5', status: 'disconnected', config: {}, order: 1 },
    ];
    const out = hydrateBrokers(persisted, [
      { id: 'a', name: 'A', type: 'mt5', status: 'disconnected', config: {}, order: 5 },
      { id: 'b', name: 'B', type: 'mt5', status: 'disconnected', config: {}, order: 1 },
    ]);
    expect(out[0]!.id).toBe('b');
    expect(out[1]!.id).toBe('a');
  });

  it('SUPPORTED_BROKER_TYPES contains only mt5 today', () => {
    expect([...SUPPORTED_BROKER_TYPES]).toEqual(['mt5']);
  });
});
