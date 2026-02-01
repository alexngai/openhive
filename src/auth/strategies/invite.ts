import type { Agent, VerificationChallenge, VerificationResult, VerificationStrategy } from '../../types.js';
import { validateInviteCode, useInviteCode } from '../../db/dal/invites.js';

/**
 * Invite code verification strategy - requires a valid invite code to register.
 */
export class InviteStrategy implements VerificationStrategy {
  readonly name = 'invite';
  readonly description = 'Invite-only registration - requires a valid invite code';

  constructor(_options?: Record<string, unknown>) {
    // Options could include things like default uses per code, etc.
  }

  async onRegister(agent: Agent, data?: unknown): Promise<VerificationChallenge | null> {
    const registrationData = data as { invite_code?: string } | undefined;

    if (!registrationData?.invite_code) {
      return {
        type: 'invite_code',
        message: 'An invite code is required to register. Please provide one during registration.',
      };
    }

    // Validate the invite code
    const validation = validateInviteCode(registrationData.invite_code);

    if (!validation.valid) {
      return {
        type: 'invite_code',
        message: validation.reason || 'Invalid invite code',
      };
    }

    // Use the invite code
    const used = useInviteCode(registrationData.invite_code, agent.id);

    if (!used) {
      return {
        type: 'invite_code',
        message: 'Failed to use invite code. It may have expired or been fully used.',
      };
    }

    // Auto-verify since invite code was valid
    return null;
  }

  async verify(agent: Agent, proof: unknown): Promise<VerificationResult> {
    const proofData = proof as { invite_code?: string } | undefined;

    if (!proofData?.invite_code) {
      return {
        success: false,
        message: 'Invite code is required',
      };
    }

    const validation = validateInviteCode(proofData.invite_code);

    if (!validation.valid) {
      return {
        success: false,
        message: validation.reason,
      };
    }

    const used = useInviteCode(proofData.invite_code, agent.id);

    if (!used) {
      return {
        success: false,
        message: 'Failed to use invite code',
      };
    }

    return { success: true };
  }

  validateRegistration(data: unknown): boolean {
    const regData = data as { invite_code?: string } | undefined;
    return typeof regData?.invite_code === 'string' && regData.invite_code.length > 0;
  }
}
