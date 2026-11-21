import React from 'react';

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={idx} className="font-semibold text-[var(--cs-ink)]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={idx}
          className="rounded bg-[var(--cs-well)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--cs-accent-ink)] border border-[var(--cs-border)]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('_') && part.endsWith('_') && part.length > 2) {
      return (
        <em key={idx} className="italic text-[var(--cs-ink-muted)]">
          {part.slice(1, -1)}
        </em>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export const MarkdownBlock: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.split('\n');
  return (
    <div className="space-y-2 text-[14px] leading-[1.62] text-[var(--cs-ink-2)] max-w-[68ch]">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} className="h-1" />;
        if (trimmed.startsWith('### ')) {
          return (
            <h4 key={i} className="cs-heading text-sm font-bold text-[var(--cs-ink)] pt-2">
              {renderInline(trimmed.slice(4))}
            </h4>
          );
        }
        if (trimmed.startsWith('## ')) {
          return (
            <h3 key={i} className="cs-heading text-[15px] font-bold text-[var(--cs-ink)] pt-2">
              {renderInline(trimmed.slice(3))}
            </h3>
          );
        }
        if (trimmed.startsWith('> ')) {
          return (
            <blockquote
              key={i}
              className="border-l-[3px] border-[var(--cs-warn)] bg-[var(--cs-warn-soft)] px-3.5 py-2.5 rounded-r-md text-[var(--cs-warn-ink)] text-xs leading-relaxed"
            >
              {renderInline(trimmed.slice(2))}
            </blockquote>
          );
        }
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          const indent = line.search(/\S/);
          return (
            <div key={i} className="flex gap-2.5" style={{ paddingLeft: Math.min(24, indent * 4) }}>
              <span className="text-[var(--cs-accent)] font-bold select-none">–</span>
              <span className="flex-1">{renderInline(trimmed.slice(2))}</span>
            </div>
          );
        }
        if (/^\d+\.\s/.test(trimmed)) {
          const dot = trimmed.indexOf('.');
          return (
            <div key={i} className="flex gap-2.5">
              <span className="font-mono text-xs text-[var(--cs-accent-ink)] font-semibold pt-0.5 cs-tabular">
                {trimmed.slice(0, dot + 1)}
              </span>
              <span className="flex-1">{renderInline(trimmed.slice(dot + 2))}</span>
            </div>
          );
        }
        return <p key={i}>{renderInline(line)}</p>;
      })}
    </div>
  );
};
