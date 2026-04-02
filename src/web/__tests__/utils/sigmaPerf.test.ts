import { describe, it, expect, vi } from 'vitest';
import { applySigmaPerfSettings } from '../../utils/sigmaPerf';

function createMockSigma() {
  const settings = new Map<string, unknown>();
  return {
    setSetting: vi.fn((key: string, value: unknown) => settings.set(key, value)),
    _settings: settings,
  };
}

describe('applySigmaPerfSettings', () => {
  it('does nothing for small graphs', () => {
    const sigma = createMockSigma();
    applySigmaPerfSettings(sigma as never, 50);
    expect(sigma.setSetting).not.toHaveBeenCalled();
  });

  it('disables edge labels above 150 nodes', () => {
    const sigma = createMockSigma();
    applySigmaPerfSettings(sigma as never, 151);
    expect(sigma.setSetting).toHaveBeenCalledWith('renderEdgeLabels', false);
  });

  it('does not disable edge labels at exactly 150 nodes', () => {
    const sigma = createMockSigma();
    applySigmaPerfSettings(sigma as never, 150);
    expect(sigma.setSetting).not.toHaveBeenCalledWith('renderEdgeLabels', false);
  });

  it('raises label threshold above 200 nodes', () => {
    const sigma = createMockSigma();
    applySigmaPerfSettings(sigma as never, 201);
    expect(sigma.setSetting).toHaveBeenCalledWith('labelRenderedSizeThreshold', 12);
  });

  it('hides edges entirely above 300 nodes', () => {
    const sigma = createMockSigma();
    applySigmaPerfSettings(sigma as never, 301);

    const edgeReducerCall = sigma.setSetting.mock.calls.find(
      ([key]: [string]) => key === 'edgeReducer',
    );
    expect(edgeReducerCall).toBeDefined();

    const reducer = edgeReducerCall![1] as () => { hidden: boolean };
    expect(reducer()).toEqual({ hidden: true });
  });

  it('applies all tiers for very large graphs', () => {
    const sigma = createMockSigma();
    applySigmaPerfSettings(sigma as never, 500);

    const keys = sigma.setSetting.mock.calls.map(([k]: [string]) => k);
    expect(keys).toContain('renderEdgeLabels');
    expect(keys).toContain('edgeReducer');
    expect(keys).toContain('labelRenderedSizeThreshold');
  });
});
