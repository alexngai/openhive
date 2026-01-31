import type { Agent, VerificationChallenge, VerificationResult, VerificationStrategy } from '../../types.js';
import { nanoid } from 'nanoid';

interface DomainOptions {
  challenge_ttl?: number; // How long challenges are valid (ms), default 24 hours
}

interface DomainChallengeData {
  domain: string;
  token: string;
  created_at: string;
  method: 'dns' | 'wellknown';
}

/**
 * Domain Verification Strategy
 *
 * Agents verify ownership of a domain by either:
 * 1. Adding a DNS TXT record: _openhive-verify.example.com TXT "token"
 * 2. Placing a file at: https://example.com/.well-known/openhive-verify.txt
 */
export class DomainStrategy implements VerificationStrategy {
  readonly name = 'domain';
  readonly description =
    'Verify ownership of a domain via DNS TXT record or .well-known file';

  private challengeTtl: number;

  constructor(options?: DomainOptions) {
    this.challengeTtl = options?.challenge_ttl || 24 * 60 * 60 * 1000; // 24 hours
  }

  validateRegistration(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const { domain } = data as { domain?: string };

    if (!domain || typeof domain !== 'string') return false;

    // Basic domain validation (supports subdomains)
    const domainRegex = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
    return domainRegex.test(domain);
  }

  async onRegister(
    _agent: Agent,
    data?: unknown
  ): Promise<VerificationChallenge | null> {
    const { domain, method = 'wellknown' } = (data as {
      domain?: string;
      method?: 'dns' | 'wellknown';
    }) || {};

    if (!domain) {
      return null;
    }

    // Generate a verification token
    const token = `openhive-verify-${nanoid(32)}`;

    // Store the challenge data in agent's verification_data
    const challengeData: DomainChallengeData = {
      domain,
      token,
      created_at: new Date().toISOString(),
      method,
    };

    if (method === 'dns') {
      return {
        type: 'dns',
        message: `Add a DNS TXT record to verify ownership of ${domain}`,
        data: {
          ...challengeData,
          record_name: `_openhive-verify.${domain}`,
          record_value: token,
          instructions: [
            `1. Go to your domain's DNS settings`,
            `2. Add a TXT record with name: _openhive-verify`,
            `3. Set the value to: ${token}`,
            `4. Wait for DNS propagation (up to 24 hours)`,
            `5. Call the verify endpoint with your agent name`,
          ],
        },
      };
    } else {
      return {
        type: 'wellknown',
        message: `Place a file at https://${domain}/.well-known/openhive-verify.txt`,
        data: {
          ...challengeData,
          file_path: `/.well-known/openhive-verify.txt`,
          file_content: token,
          instructions: [
            `1. Create a file at https://${domain}/.well-known/openhive-verify.txt`,
            `2. Set the file content to: ${token}`,
            `3. Make sure the file is publicly accessible`,
            `4. Call the verify endpoint with your agent name`,
          ],
        },
      };
    }
  }

  async verify(agent: Agent, _proof: unknown): Promise<VerificationResult> {
    const verificationData = agent.verification_data as unknown as DomainChallengeData | null;
    const { domain, token, method, created_at } = verificationData || {} as Partial<DomainChallengeData>;

    if (!domain || !token || !created_at) {
      return {
        success: false,
        message: 'No pending domain verification challenge',
      };
    }

    // Check if challenge has expired
    const challengeAge = Date.now() - new Date(created_at).getTime();
    if (challengeAge > this.challengeTtl) {
      return {
        success: false,
        message: 'Domain verification challenge has expired',
      };
    }

    try {
      let verified = false;

      if (method === 'dns') {
        verified = await this.verifyDns(domain, token);
      } else {
        verified = await this.verifyWellKnown(domain, token);
      }

      if (verified) {
        return {
          success: true,
          message: `Domain ${domain} verified successfully`,
        };
      } else {
        return {
          success: false,
          message: `Could not verify domain ownership. Make sure the ${method === 'dns' ? 'DNS TXT record' : '.well-known file'} is correctly set up.`,
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Verification error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  private async verifyDns(domain: string, token: string): Promise<boolean> {
    try {
      const { Resolver } = await import('dns').then((m) => m.promises);
      const resolver = new Resolver();

      // Try to resolve the TXT record
      const recordName = `_openhive-verify.${domain}`;
      const records = await resolver.resolveTxt(recordName);

      // Check if any record matches our token
      for (const record of records) {
        const value = record.join('');
        if (value === token) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private async verifyWellKnown(domain: string, token: string): Promise<boolean> {
    try {
      const url = `https://${domain}/.well-known/openhive-verify.txt`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'OpenHive/0.2.0 DomainVerification',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return false;
      }

      const content = await response.text();
      return content.trim() === token;
    } catch {
      return false;
    }
  }
}
