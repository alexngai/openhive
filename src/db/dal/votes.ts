import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type { Vote } from '../../types.js';
import { updatePostScore, findPostById } from './posts.js';
import { updateCommentScore, findCommentById } from './comments.js';
import { updateAgentKarma } from './agents.js';

export interface CastVoteInput {
  agent_id: string;
  target_type: 'post' | 'comment';
  target_id: string;
  value: 1 | -1;
}

export function castVote(input: CastVoteInput): { vote: Vote; scoreDelta: number } {
  const db = getDatabase();

  // Check for existing vote
  const existing = db.prepare(
    'SELECT * FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?'
  ).get(input.agent_id, input.target_type, input.target_id) as Vote | undefined;

  let scoreDelta = 0;
  let vote: Vote;

  if (existing) {
    if (existing.value === input.value) {
      // Same vote, remove it (toggle off)
      db.prepare('DELETE FROM votes WHERE id = ?').run(existing.id);
      scoreDelta = -input.value;
      vote = existing;
    } else {
      // Different vote, update it
      db.prepare('UPDATE votes SET value = ?, created_at = datetime("now") WHERE id = ?').run(
        input.value,
        existing.id
      );
      scoreDelta = input.value * 2; // Swing from -1 to +1 or vice versa
      vote = { ...existing, value: input.value };
    }
  } else {
    // New vote
    const id = nanoid();
    db.prepare(`
      INSERT INTO votes (id, agent_id, target_type, target_id, value)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, input.agent_id, input.target_type, input.target_id, input.value);
    scoreDelta = input.value;
    vote = {
      id,
      agent_id: input.agent_id,
      target_type: input.target_type,
      target_id: input.target_id,
      value: input.value,
      created_at: new Date().toISOString(),
    };
  }

  // Update target score
  if (scoreDelta !== 0) {
    if (input.target_type === 'post') {
      updatePostScore(input.target_id, scoreDelta);
      // Update author karma
      const post = findPostById(input.target_id);
      if (post) {
        updateAgentKarma(post.author_id, scoreDelta);
      }
    } else {
      updateCommentScore(input.target_id, scoreDelta);
      // Update author karma
      const comment = findCommentById(input.target_id);
      if (comment) {
        updateAgentKarma(comment.author_id, scoreDelta);
      }
    }
  }

  return { vote, scoreDelta };
}

export function getVote(agentId: string, targetType: 'post' | 'comment', targetId: string): Vote | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?'
  ).get(agentId, targetType, targetId) as Vote | undefined;
  return row || null;
}

export function getVotesForTarget(targetType: 'post' | 'comment', targetId: string): Vote[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM votes WHERE target_type = ? AND target_id = ?').all(targetType, targetId) as Vote[];
}

export function removeVote(agentId: string, targetType: 'post' | 'comment', targetId: string): boolean {
  const db = getDatabase();

  const existing = getVote(agentId, targetType, targetId);
  if (!existing) return false;

  const result = db.prepare(
    'DELETE FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?'
  ).run(agentId, targetType, targetId);

  if (result.changes > 0) {
    // Reverse the score
    const scoreDelta = -existing.value;
    if (targetType === 'post') {
      updatePostScore(targetId, scoreDelta);
      const post = findPostById(targetId);
      if (post) {
        updateAgentKarma(post.author_id, scoreDelta);
      }
    } else {
      updateCommentScore(targetId, scoreDelta);
      const comment = findCommentById(targetId);
      if (comment) {
        updateAgentKarma(comment.author_id, scoreDelta);
      }
    }
    return true;
  }

  return false;
}
