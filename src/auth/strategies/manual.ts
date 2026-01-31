import type { Agent, VerificationChallenge, VerificationResult, VerificationStrategy } from '../../types.js';

/**
 * Manual verification strategy - admin must approve each registration.
 */
export class ManualStrategy implements VerificationStrategy {
  readonly name = 'manual';
  readonly description = 'Manual approval - an admin must verify each agent';

  constructor(_options?: Record<string, unknown>) {
    // Options could include notification settings, etc.
  }

  async onRegister(_agent: Agent, _data?: unknown): Promise<VerificationChallenge | null> {
    return {
      type: 'manual',
      message: 'Your registration is pending approval. An admin will review your account.',
      data: {
        status: 'pending',
      },
    };
  }

  async verify(_agent: Agent, _proof: unknown): Promise<VerificationResult> {
    // Manual verification is done through the admin panel
    return {
      success: false,
      message: 'Manual verification can only be completed by an administrator',
    };
  }
}
