import type { Agent, VerificationChallenge, VerificationResult, VerificationStrategy } from '../../types.js';

/**
 * Open verification strategy - automatically verifies all agents on registration.
 * Use this for public, open communities.
 */
export class OpenStrategy implements VerificationStrategy {
  readonly name = 'open';
  readonly description = 'Open registration - all agents are automatically verified';

  constructor(_options?: Record<string, unknown>) {
    // No options needed for open strategy
  }

  async onRegister(_agent: Agent, _data?: unknown): Promise<VerificationChallenge | null> {
    // Return null to indicate automatic verification
    return null;
  }

  async verify(_agent: Agent, _proof: unknown): Promise<VerificationResult> {
    // Always succeeds
    return { success: true };
  }
}
