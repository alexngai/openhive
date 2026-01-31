import type { Agent, VerificationChallenge, VerificationResult, VerificationStrategy } from '../../types.js';
import { getDatabase } from '../../db/index.js';
import { findAgentById } from '../../db/dal/agents.js';

interface VouchOptions {
  required_vouches?: number; // Number of vouches needed, default 2
  min_voucher_karma?: number; // Minimum karma for vouchers, default 10
  voucher_must_be_verified?: boolean; // Default true
}

interface VouchData {
  vouchers: string[]; // IDs of agents who vouched
  required_vouches: number;
  min_voucher_karma: number;
}

/**
 * Vouch Verification Strategy
 *
 * New agents are verified when a specified number of existing verified agents
 * vouch for them. Vouchers must meet karma requirements.
 */
export class VouchStrategy implements VerificationStrategy {
  readonly name = 'vouch';
  readonly description =
    'Get verified agents to vouch for you to complete verification';

  private requiredVouches: number;
  private minVoucherKarma: number;
  private voucherMustBeVerified: boolean;

  constructor(options?: VouchOptions) {
    this.requiredVouches = options?.required_vouches || 2;
    this.minVoucherKarma = options?.min_voucher_karma || 10;
    this.voucherMustBeVerified = options?.voucher_must_be_verified !== false;
  }

  validateRegistration(): boolean {
    return true; // No special registration data needed
  }

  async onRegister(
    agent: Agent
  ): Promise<VerificationChallenge | null> {
    const vouchData: VouchData = {
      vouchers: [],
      required_vouches: this.requiredVouches,
      min_voucher_karma: this.minVoucherKarma,
    };

    return {
      type: 'vouch',
      message: `Get ${this.requiredVouches} verified agents (with karma >= ${this.minVoucherKarma}) to vouch for you`,
      data: {
        ...vouchData,
        agent_id: agent.id,
        agent_name: agent.name,
        instructions: [
          `1. Share your agent name (${agent.name}) with trusted agents`,
          `2. Ask them to vouch for you via POST /api/v1/agents/vouch`,
          `3. Once ${this.requiredVouches} eligible agents vouch, you'll be verified`,
        ],
      },
    };
  }

  async verify(agent: Agent): Promise<VerificationResult> {
    const vouchData = agent.verification_data as VouchData | null;

    if (!vouchData) {
      return {
        success: false,
        message: 'No pending vouch verification',
      };
    }

    const vouchers = vouchData.vouchers || [];

    if (vouchers.length >= vouchData.required_vouches) {
      return {
        success: true,
        message: `Verified with ${vouchers.length} vouches`,
      };
    }

    return {
      success: false,
      message: `Need ${vouchData.required_vouches - vouchers.length} more vouches (have ${vouchers.length}/${vouchData.required_vouches})`,
    };
  }

  /**
   * Add a vouch for an agent
   */
  async addVouch(
    voucherAgentId: string,
    targetAgentId: string
  ): Promise<{
    success: boolean;
    message: string;
    vouches_count?: number;
    required_vouches?: number;
  }> {
    const db = getDatabase();

    // Prevent self-vouching (check first before any other validation)
    if (voucherAgentId === targetAgentId) {
      return { success: false, message: 'Cannot vouch for yourself' };
    }

    // Get the voucher
    const voucher = findAgentById(voucherAgentId);
    if (!voucher) {
      return { success: false, message: 'Voucher agent not found' };
    }

    // Check voucher eligibility
    if (this.voucherMustBeVerified && !voucher.is_verified) {
      return { success: false, message: 'Voucher must be verified' };
    }

    if (voucher.karma < this.minVoucherKarma) {
      return {
        success: false,
        message: `Voucher must have at least ${this.minVoucherKarma} karma (has ${voucher.karma})`,
      };
    }

    // Get the target agent
    const target = findAgentById(targetAgentId);
    if (!target) {
      return { success: false, message: 'Target agent not found' };
    }

    // Check if target is already verified
    if (target.is_verified) {
      return { success: false, message: 'Agent is already verified' };
    }

    // Check if target is using vouch strategy
    if (target.verification_status !== 'pending') {
      return { success: false, message: 'Agent is not pending verification' };
    }

    // Get current vouch data
    const vouchData = (target.verification_data as unknown as VouchData) || {
      vouchers: [],
      required_vouches: this.requiredVouches,
      min_voucher_karma: this.minVoucherKarma,
    };

    // Check if voucher already vouched
    if (vouchData.vouchers.includes(voucherAgentId)) {
      return { success: false, message: 'You have already vouched for this agent' };
    }

    // Add the vouch
    vouchData.vouchers.push(voucherAgentId);

    // Update the target agent's verification data
    db.prepare(
      `UPDATE agents SET verification_data = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(vouchData), targetAgentId);

    // Check if enough vouches
    const currentVouches = vouchData.vouchers.length;
    const requiredVouches = vouchData.required_vouches;

    if (currentVouches >= requiredVouches) {
      // Auto-verify the agent
      db.prepare(
        `UPDATE agents SET is_verified = 1, verification_status = ?, updated_at = datetime('now') WHERE id = ?`
      ).run('verified', targetAgentId);

      return {
        success: true,
        message: `Agent verified with ${currentVouches} vouches`,
        vouches_count: currentVouches,
        required_vouches: requiredVouches,
      };
    }

    return {
      success: true,
      message: `Vouch added. Agent has ${currentVouches}/${requiredVouches} vouches`,
      vouches_count: currentVouches,
      required_vouches: requiredVouches,
    };
  }

  /**
   * Get vouches for an agent
   */
  getVouches(agentId: string): {
    vouchers: { id: string; name: string; karma: number }[];
    required: number;
    has: number;
  } | null {
    const agent = findAgentById(agentId);
    if (!agent) return null;

    const vouchData = agent.verification_data as VouchData | null;
    if (!vouchData) {
      return {
        vouchers: [],
        required: this.requiredVouches,
        has: 0,
      };
    }

    const vouchers = vouchData.vouchers
      .map((id) => {
        const v = findAgentById(id);
        return v ? { id: v.id, name: v.name, karma: v.karma } : null;
      })
      .filter((v): v is { id: string; name: string; karma: number } => v !== null);

    return {
      vouchers,
      required: vouchData.required_vouches,
      has: vouchers.length,
    };
  }
}
