import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { go } from '@codemirror/legacy-modes/mode/go';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { c, cpp, java, csharp } from '@codemirror/legacy-modes/mode/clike';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { toml } from '@codemirror/legacy-modes/mode/toml';

function languageForFile(path: string): Extension {
  const extension = path.split('.').pop()?.toLowerCase();
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'].includes(extension ?? '')) {
    return javascript({ typescript: ['ts', 'mts', 'cts', 'tsx'].includes(extension!), jsx: ['jsx', 'tsx'].includes(extension!) });
  }
  switch (extension) {
    case 'json': case 'jsonc': return json();
    case 'css': return css();
    case 'html': case 'htm': case 'svg': return html();
    case 'md': case 'markdown': return markdown();
    case 'py': case 'pyw': return python();
    case 'yaml': case 'yml': return StreamLanguage.define(yaml);
    case 'sh': case 'bash': case 'zsh': return StreamLanguage.define(shell);
    case 'ps1': case 'psm1': case 'psd1': return StreamLanguage.define(powerShell);
    case 'go': return StreamLanguage.define(go);
    case 'rs': return StreamLanguage.define(rust);
    case 'c': case 'h': return StreamLanguage.define(c);
    case 'cpp': case 'hpp': case 'cc': return StreamLanguage.define(cpp);
    case 'java': return StreamLanguage.define(java);
    case 'cs': return StreamLanguage.define(csharp);
    case 'sql': return StreamLanguage.define(standardSQL);
    case 'toml': return StreamLanguage.define(toml);
    default: return [];
  }
}

const colors = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: '#c4a1ef' },
  { tag: [tags.string, tags.regexp], color: '#a6c993' },
  { tag: [tags.number, tags.bool, tags.null], color: '#e5b77e' },
  { tag: [tags.comment], color: '#777d72', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#d9c58f' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#80c9bb' },
  { tag: [tags.propertyName, tags.attributeName], color: '#a1c5e7' },
  { tag: [tags.tagName], color: '#d69c8a' },
  { tag: [tags.operator, tags.punctuation], color: '#b9b9b9' },
  { tag: [tags.heading], color: '#d9c58f', fontWeight: 'bold' },
  { tag: [tags.link, tags.url], color: '#80c9bb', textDecoration: 'underline' },
  { tag: [tags.invalid], color: '#ef8e8e' },
]));
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: '#d6d6d6', fontSize: '13px' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, Menlo, monospace', lineHeight: '1.7' },
  '.cm-content': { padding: '12px 0', caretColor: '#eeeeee' },
  '.cm-line': { padding: '0 16px' },
  '.cm-gutters': { backgroundColor: '#121212', color: '#606060', border: 'none', borderRight: '1px solid #232323' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '42px', padding: '0 10px 0 8px' },
  '.cm-activeLineGutter': { backgroundColor: '#202020', color: '#bcbcbc' },
  '.cm-activeLine': { backgroundColor: '#ffffff04' },
  '.cm-cursor': { borderLeftColor: '#e6e6e6' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#ffffff20' },
  '.cm-matchingBracket': { backgroundColor: '#ffffff18', outline: '1px solid #ffffff30' },
  '.cm-panels, .cm-tooltip': { backgroundColor: '#202020', color: '#d6d6d6', borderColor: '#393939' },
  '.cm-searchMatch': { backgroundColor: '#bda35a30' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#bda35a55' },
}, { dark: true });

export function CodeEditor({ path, text, wrap, onChange }: { path: string; text: string; wrap: boolean; onChange: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const wrapping = useRef(new Compartment());
  useEffect(() => {
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: text, extensions: [
      basicSetup, theme, colors, languageForFile(path), indentUnit.of('  '), keymap.of([indentWithTab]),
      EditorView.contentAttributes.of({ 'aria-label': path, spellcheck: 'false' }),
      wrapping.current.of(wrap ? EditorView.lineWrapping : []),
      EditorView.updateListener.of(update => { if (update.docChanged) changed.current(update.state.doc.toString()); }),
    ] }) });
    view.current = editor;
    editor.focus();
    return () => { view.current = null; editor.destroy(); };
  }, [path]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== text) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  }, [text]);
  useEffect(() => { view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) }); }, [wrap]);
  return <div ref={host} className="code-editor" />;
}
