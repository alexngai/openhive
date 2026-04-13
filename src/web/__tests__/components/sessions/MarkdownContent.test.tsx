import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownContent } from '../../../components/sessions/MarkdownContent';

describe('MarkdownContent', () => {
  it('renders plain text', () => {
    render(<MarkdownContent>Hello world</MarkdownContent>);
    expect(screen.getByText('Hello world')).toBeDefined();
  });

  it('renders bold text', () => {
    render(<MarkdownContent>{'**bold text**'}</MarkdownContent>);
    const strong = screen.getByText('bold text');
    expect(strong.tagName).toBe('STRONG');
  });

  it('renders italic text', () => {
    render(<MarkdownContent>{'*italic text*'}</MarkdownContent>);
    const em = screen.getByText('italic text');
    expect(em.tagName).toBe('EM');
  });

  it('renders inline code', () => {
    render(<MarkdownContent>{'Use `console.log` to debug'}</MarkdownContent>);
    const code = screen.getByText('console.log');
    expect(code.tagName).toBe('CODE');
  });

  it('renders code blocks with pre element', () => {
    const markdown = '```js\nconst x = 1;\n```';
    const { container } = render(<MarkdownContent>{markdown}</MarkdownContent>);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    const code = pre?.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('const x = 1;');
  });

  it('renders links with target="_blank"', () => {
    render(<MarkdownContent>{'[click here](https://example.com)'}</MarkdownContent>);
    const link = screen.getByText('click here');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('href')).toBe('https://example.com');
  });

  it('renders unordered lists', () => {
    const markdown = '- item one\n- item two';
    const { container } = render(<MarkdownContent>{markdown}</MarkdownContent>);
    const ul = container.querySelector('ul');
    expect(ul).not.toBeNull();
    const items = ul?.querySelectorAll('li');
    expect(items?.length).toBe(2);
  });

  it('renders GFM strikethrough', () => {
    render(<MarkdownContent>{'~~deleted~~'}</MarkdownContent>);
    const del = screen.getByText('deleted');
    expect(del.tagName).toBe('DEL');
  });

  it('applies the markdown-content class', () => {
    const { container } = render(<MarkdownContent>{'text'}</MarkdownContent>);
    expect(container.firstElementChild?.classList.contains('markdown-content')).toBe(true);
  });

  it('applies additional className', () => {
    const { container } = render(<MarkdownContent className="text-xs">{'text'}</MarkdownContent>);
    expect(container.firstElementChild?.classList.contains('text-xs')).toBe(true);
  });

  it('renders headings', () => {
    const { container } = render(<MarkdownContent>{'## Section Title'}</MarkdownContent>);
    const h2 = container.querySelector('h2');
    expect(h2).not.toBeNull();
    expect(h2?.textContent).toBe('Section Title');
  });

  it('renders blockquotes', () => {
    const { container } = render(<MarkdownContent>{'> quoted text'}</MarkdownContent>);
    const blockquote = container.querySelector('blockquote');
    expect(blockquote).not.toBeNull();
    expect(blockquote?.textContent).toContain('quoted text');
  });
});
