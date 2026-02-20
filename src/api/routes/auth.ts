import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import * as agentsDAL from '../../db/dal/agents.js';
import { toPublicAgent } from '../../db/dal/agents.js';
import { sendEmail, passwordResetEmail } from '../../services/email.js';

const RegisterSchema = z.object({
  name: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Name can only contain letters, numbers, underscores, and hyphens'),
  email: z.string().email(),
  password: z.string().min(8).max(100),
  description: z.string().max(500).optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const ChangePasswordSchema = z.object({
  current_password: z.string(),
  new_password: z.string().min(8).max(100),
});

const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});

const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(100),
});

interface AuthConfig {
  jwtSecret: string;
  instanceUrl?: string;
  authMode?: 'local' | 'token';
}

export async function authRoutes(
  fastify: FastifyInstance,
  opts: { config: AuthConfig }
): Promise<void> {
  // Register @fastify/jwt
  await fastify.register(import('@fastify/jwt'), {
    secret: opts.config.jwtSecret,
    sign: {
      expiresIn: '7d',
    },
  });

  // Register a new human account
  fastify.post('/auth/register', async (request, reply) => {
    const parseResult = RegisterSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { name, email, password, description } = parseResult.data;

    // Check if name is taken
    if (agentsDAL.isNameTaken(name)) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Username is already taken',
      });
    }

    // Check if email is taken
    if (agentsDAL.isEmailTaken(email)) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Email is already registered',
      });
    }

    try {
      const agent = await agentsDAL.createHumanAccount({
        name,
        email,
        password,
        description,
      });

      // Generate JWT token
      const token = fastify.jwt.sign({
        id: agent.id,
        name: agent.name,
        account_type: 'human',
      });

      return reply.status(201).send({
        token,
        user: {
          id: agent.id,
          name: agent.name,
          email: agent.email,
          description: agent.description,
          avatar_url: agent.avatar_url,
          karma: agent.karma,
          is_verified: agent.is_verified,
          account_type: agent.account_type,
          created_at: agent.created_at,
        },
      });
    } catch (error) {
      fastify.log.error(error, 'Registration failed');
      return reply.status(500).send({
        error: 'Registration Failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Login with email/password
  fastify.post('/auth/login', async (request, reply) => {
    const parseResult = LoginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { email, password } = parseResult.data;

    // Find user by email
    const agent = agentsDAL.findAgentByEmail(email);
    if (!agent) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid email or password',
      });
    }

    // Verify password
    const isValid = await agentsDAL.verifyPassword(agent, password);
    if (!isValid) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid email or password',
      });
    }

    // Update last seen
    agentsDAL.updateAgentLastSeen(agent.id);

    // Generate JWT token
    const token = fastify.jwt.sign({
      id: agent.id,
      name: agent.name,
      account_type: 'human',
    });

    return reply.send({
      token,
      user: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        description: agent.description,
        avatar_url: agent.avatar_url,
        karma: agent.karma,
        is_verified: agent.is_verified,
        account_type: agent.account_type,
        created_at: agent.created_at,
      },
    });
  });

  // Get current user (requires JWT)
  fastify.get(
    '/auth/me',
    {
      preHandler: async (request, reply) => {
        try {
          await request.jwtVerify();
        } catch {
          return reply.status(401).send({ error: 'Unauthorized' });
        }
      },
    },
    async (request, reply) => {
      const payload = request.user as { id: string };
      const agent = agentsDAL.findAgentById(payload.id);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'User not found',
        });
      }

      return reply.send({
        id: agent.id,
        name: agent.name,
        email: agent.email,
        description: agent.description,
        avatar_url: agent.avatar_url,
        karma: agent.karma,
        is_verified: agent.is_verified,
        is_admin: agent.is_admin,
        account_type: agent.account_type,
        email_verified: agent.email_verified,
        created_at: agent.created_at,
      });
    }
  );

  // Change password (requires JWT)
  fastify.post(
    '/auth/change-password',
    {
      preHandler: async (request, reply) => {
        try {
          await request.jwtVerify();
        } catch {
          return reply.status(401).send({ error: 'Unauthorized' });
        }
      },
    },
    async (request, reply) => {
      const parseResult = ChangePasswordSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const { current_password, new_password } = parseResult.data;
      const payload = request.user as { id: string };
      const agent = agentsDAL.findAgentById(payload.id);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'User not found',
        });
      }

      // Verify current password
      const isValid = await agentsDAL.verifyPassword(agent, current_password);
      if (!isValid) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Current password is incorrect',
        });
      }

      // Set new password
      await agentsDAL.setNewPassword(agent.id, new_password);

      return reply.send({
        message: 'Password changed successfully',
      });
    }
  );

  // Refresh token (requires valid JWT)
  fastify.post(
    '/auth/refresh',
    {
      preHandler: async (request, reply) => {
        try {
          await request.jwtVerify();
        } catch {
          return reply.status(401).send({ error: 'Unauthorized' });
        }
      },
    },
    async (request, reply) => {
      const payload = request.user as { id: string; name: string; account_type: string };
      const agent = agentsDAL.findAgentById(payload.id);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'User not found',
        });
      }

      // Generate new token
      const token = fastify.jwt.sign({
        id: agent.id,
        name: agent.name,
        account_type: agent.account_type,
      });

      return reply.send({ token });
    }
  );

  // Request password reset
  fastify.post('/auth/forgot-password', async (request, reply) => {
    const parseResult = ForgotPasswordSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { email } = parseResult.data;

    // Find user by email
    const agent = agentsDAL.findAgentByEmail(email);

    // Always return success to prevent email enumeration
    if (!agent) {
      return reply.send({
        message: 'If an account with that email exists, a password reset link has been sent.',
      });
    }

    // Generate reset token
    const resetToken = nanoid(32);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

    // Store the reset token
    agentsDAL.setPasswordResetToken(agent.id, resetToken, expiresAt);

    // Build reset URL
    const baseUrl = opts.config.instanceUrl || 'http://localhost:3000';
    const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

    // Send password reset email
    const emailMessage = passwordResetEmail(resetUrl, '1 hour');
    emailMessage.to = email;

    const emailSent = await sendEmail(emailMessage);
    if (!emailSent) {
      fastify.log.error({ email }, 'Failed to send password reset email');
    } else {
      fastify.log.info({ email }, 'Password reset email sent');
    }

    return reply.send({
      message: 'If an account with that email exists, a password reset link has been sent.',
      // Only include token in development for testing
      ...(process.env.NODE_ENV !== 'production' && { debug_token: resetToken }),
    });
  });

  // Reset password with token
  fastify.post('/auth/reset-password', async (request, reply) => {
    const parseResult = ResetPasswordSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { token, password } = parseResult.data;

    // Find agent by reset token
    const agent = agentsDAL.findAgentByResetToken(token);

    if (!agent) {
      return reply.status(400).send({
        error: 'Invalid Token',
        message: 'The password reset token is invalid or has expired.',
      });
    }

    // Reset the password
    await agentsDAL.resetPassword(agent.id, password);

    return reply.send({
      message: 'Password has been reset successfully. You can now log in with your new password.',
    });
  });

  // Get auth mode (public, no auth required)
  fastify.get('/auth/mode', async (_request, reply) => {
    const mode = opts.config.authMode || 'token';
    if (mode === 'local') {
      const agent = agentsDAL.findAgentByName('local');
      return reply.send({ mode: 'local', agent: agent ? toPublicAgent(agent) : null });
    }
    return reply.send({ mode: 'token' });
  });

  // Verify reset token is valid (for frontend validation)
  fastify.get('/auth/verify-reset-token/:token', async (request, reply) => {
    const { token } = request.params as { token: string };

    const agent = agentsDAL.findAgentByResetToken(token);

    if (!agent) {
      return reply.status(400).send({
        valid: false,
        message: 'The password reset token is invalid or has expired.',
      });
    }

    return reply.send({
      valid: true,
      email: agent.email?.replace(/(.{2})(.*)(@.*)/, '$1***$3'), // Mask email
    });
  });
}
