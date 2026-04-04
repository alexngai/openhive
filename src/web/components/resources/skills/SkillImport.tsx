import { useState } from 'react';
import { Upload, FileText, Database, CheckCircle, AlertTriangle } from 'lucide-react';
import { useImportSkills } from '../../../hooks/useApi';
import type { ImportResult } from '../../../lib/api';

type Format = 'json' | 'agents-md' | 'indexer';

const FORMAT_INFO: Record<Format, { label: string; icon: React.ElementType; placeholder: string; description: string }> = {
  json: {
    label: 'JSON Skills',
    icon: Database,
    placeholder: '[\n  {\n    "name": "My Skill",\n    "description": "...",\n    "problem": "...",\n    "solution": "..."\n  }\n]',
    description: 'Array of skill objects or { skills: [...] }',
  },
  'agents-md': {
    label: 'AGENTS.md',
    icon: FileText,
    placeholder: '## My Skill\n\n### Problem\nWhat this skill solves...\n\n### Solution\nHow to apply it...',
    description: 'Paste AGENTS.md content with skill definitions',
  },
  indexer: {
    label: 'Indexer Export',
    icon: Upload,
    placeholder: '{\n  "exportedAt": "...",\n  "skills": [\n    { "name": "...", "sourceRepo": "...", ... }\n  ]\n}',
    description: 'JSON export from skill-tree indexer / scraper',
  },
};

export function SkillImport({ resourceId }: { resourceId: string }) {
  const [format, setFormat] = useState<Format>('json');
  const [content, setContent] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const importSkills = useImportSkills(resourceId);

  async function handleImport() {
    if (!content.trim()) return;
    setResult(null);

    try {
      const res = await importSkills.mutateAsync({ format, content });
      setResult(res);
      if (res.imported > 0) setContent('');
    } catch (err) {
      setResult({ format, imported: 0, failed: 1, warnings: [err instanceof Error ? err.message : 'Import failed'] });
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setContent(reader.result as string);
    };
    reader.readAsText(file);
  }

  const info = FORMAT_INFO[format];

  return (
    <div className="space-y-3">
      {/* Format selector */}
      <div className="flex gap-1">
        {(Object.keys(FORMAT_INFO) as Format[]).map(f => {
          const Icon = FORMAT_INFO[f].icon;
          return (
            <button
              key={f}
              onClick={() => { setFormat(f); setResult(null); }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-2xs transition-colors cursor-pointer"
              style={format === f ? {
                color: 'var(--color-honey-500)',
                backgroundColor: 'var(--color-elevated)',
              } : {
                color: 'var(--color-text-muted)',
              }}
            >
              <Icon className="w-3 h-3" />
              {FORMAT_INFO[f].label}
            </button>
          );
        })}
      </div>

      <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>{info.description}</p>

      {/* Content input */}
      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        placeholder={info.placeholder}
        rows={10}
        className="input w-full text-xs font-mono"
        style={{ resize: 'vertical' }}
      />

      {/* File upload */}
      <div className="flex items-center gap-3">
        <label className="text-2xs flex items-center gap-1.5 cursor-pointer hover:text-honey-500 transition-colors" style={{ color: 'var(--color-text-muted)' }}>
          <Upload className="w-3 h-3" />
          Upload file
          <input type="file" accept=".json,.md,.txt" onChange={handleFileUpload} className="hidden" />
        </label>

        <div className="flex-1" />

        <button
          onClick={handleImport}
          disabled={!content.trim() || importSkills.isPending}
          className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
        >
          <Upload className="w-3.5 h-3.5" />
          {importSkills.isPending ? 'Importing...' : 'Import'}
        </button>
      </div>

      {/* Result */}
      {result && (
        <div
          className="rounded-md p-3 text-xs space-y-1"
          style={{ backgroundColor: result.imported > 0 ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)' }}
        >
          <div className="flex items-center gap-1.5">
            {result.imported > 0 ? (
              <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            )}
            <span>
              {result.imported} imported, {result.failed} failed
            </span>
          </div>
          {result.warnings?.map((w, i) => (
            <div key={i} className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>{w}</div>
          ))}
        </div>
      )}
    </div>
  );
}
