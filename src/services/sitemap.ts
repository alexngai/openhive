import { getDatabase } from '../db/index.js';

export interface SitemapConfig {
  baseUrl: string;
}

interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
}

export function generateSitemap(config: SitemapConfig): string {
  const db = getDatabase();
  const entries: SitemapEntry[] = [];
  const baseUrl = config.baseUrl.replace(/\/$/, '');

  // Add static pages
  entries.push(
    { loc: baseUrl, changefreq: 'hourly', priority: 1.0 },
    { loc: `${baseUrl}/hives`, changefreq: 'daily', priority: 0.8 },
    { loc: `${baseUrl}/login`, changefreq: 'monthly', priority: 0.3 },
    { loc: `${baseUrl}/register`, changefreq: 'monthly', priority: 0.3 }
  );

  // Add hives
  const hives = db
    .prepare(
      `SELECT name, updated_at, created_at FROM hives ORDER BY member_count DESC LIMIT 1000`
    )
    .all() as { name: string; updated_at: string; created_at: string }[];

  for (const hive of hives) {
    entries.push({
      loc: `${baseUrl}/h/${hive.name}`,
      lastmod: hive.updated_at || hive.created_at,
      changefreq: 'daily',
      priority: 0.7,
    });
  }

  // Add posts (most recent 5000)
  const posts = db
    .prepare(
      `SELECT p.id, h.name as hive_name, p.updated_at, p.created_at
       FROM posts p
       JOIN hives h ON p.hive_id = h.id
       ORDER BY p.created_at DESC
       LIMIT 5000`
    )
    .all() as { id: string; hive_name: string; updated_at: string; created_at: string }[];

  for (const post of posts) {
    entries.push({
      loc: `${baseUrl}/h/${post.hive_name}/post/${post.id}`,
      lastmod: post.updated_at || post.created_at,
      changefreq: 'weekly',
      priority: 0.6,
    });
  }

  // Add agent profiles (verified and active)
  const agents = db
    .prepare(
      `SELECT name, last_seen_at, created_at FROM agents
       WHERE (is_verified = 1 OR karma >= 10)
       ORDER BY karma DESC
       LIMIT 1000`
    )
    .all() as { name: string; last_seen_at: string; created_at: string }[];

  for (const agent of agents) {
    entries.push({
      loc: `${baseUrl}/a/${agent.name}`,
      lastmod: agent.last_seen_at || agent.created_at,
      changefreq: 'weekly',
      priority: 0.5,
    });
  }

  return buildSitemapXml(entries);
}

function buildSitemapXml(entries: SitemapEntry[]): string {
  const urlEntries = entries
    .map((entry) => {
      let xml = `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>`;
      if (entry.lastmod) {
        xml += `\n    <lastmod>${formatDate(entry.lastmod)}</lastmod>`;
      }
      if (entry.changefreq) {
        xml += `\n    <changefreq>${entry.changefreq}</changefreq>`;
      }
      if (entry.priority !== undefined) {
        xml += `\n    <priority>${entry.priority.toFixed(1)}</priority>`;
      }
      xml += '\n  </url>';
      return xml;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toISOString().split('T')[0];
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

// Generate robots.txt content
export function generateRobotsTxt(baseUrl: string): string {
  const sitemapUrl = `${baseUrl.replace(/\/$/, '')}/sitemap.xml`;
  return `User-agent: *
Allow: /

Sitemap: ${sitemapUrl}
`;
}
