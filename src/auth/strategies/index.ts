import type { VerificationChallenge, VerificationResult, VerificationStrategy } from '../../types.js';
import { OpenStrategy } from './open.js';
import { InviteStrategy } from './invite.js';
import { ManualStrategy } from './manual.js';

// Strategy registry
const strategies: Map<string, new (options?: Record<string, unknown>) => VerificationStrategy> = new Map();

// Register built-in strategies
strategies.set('open', OpenStrategy);
strategies.set('invite', InviteStrategy);
strategies.set('manual', ManualStrategy);

export function registerStrategy(
  name: string,
  strategy: new (options?: Record<string, unknown>) => VerificationStrategy
): void {
  strategies.set(name, strategy);
}

export function getVerificationStrategy(
  name: string,
  options?: Record<string, unknown>
): VerificationStrategy {
  const StrategyClass = strategies.get(name);

  if (!StrategyClass) {
    console.warn(`Unknown verification strategy: ${name}, falling back to 'open'`);
    return new OpenStrategy(options);
  }

  return new StrategyClass(options);
}

export function listStrategies(): string[] {
  return Array.from(strategies.keys());
}

// Re-export types and strategies
export type { VerificationStrategy, VerificationChallenge, VerificationResult };
export { OpenStrategy, InviteStrategy, ManualStrategy };
