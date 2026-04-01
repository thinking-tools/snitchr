import { describe, it, expect } from 'vitest';
import { layout } from './layout';

describe('layout', () => {
  const html = layout('Test Page', '<p>Hello</p>');

  it('includes html tag', () => {
    expect(html).toContain('<html');
  });

  it('includes head tag', () => {
    expect(html).toContain('<head>');
  });

  it('includes body tag', () => {
    expect(html).toContain('<body');
  });

  it('injects page title', () => {
    expect(html).toContain('<title>Test Page');
  });

  it('injects body content', () => {
    expect(html).toContain('<p>Hello</p>');
  });

  it('includes oat-glassed CSS', () => {
    expect(html).toContain('oat-glassed');
  });
});
