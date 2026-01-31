import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as agentsDAL from '../../db/dal/agents.js';

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

interface AuthConfig {
  jwtSecret: string;
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
}
