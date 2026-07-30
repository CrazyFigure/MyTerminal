import { Fragment, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { writeClipboardText } from './clipboard';
import { parseMarkdown, type InlineSpan, type MarkdownNode } from './markdown';

/** 渲染行内标记。 */
function InlineSpans({ spans }: { spans: InlineSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        switch (span.type) {
          case 'code':
            return (
              <code key={index} className="md-inline-code">
                {span.text}
              </code>
            );
          case 'bold':
            return <strong key={index}>{span.text}</strong>;
          case 'italic':
            return <em key={index}>{span.text}</em>;
          case 'link':
            // 不做跳转：AI 给的链接可能指向任意地址，这里只展示文本与地址，避免误触外链。
            return (
              <span key={index} className="md-link" title={span.href}>
                {span.text || span.href}
              </span>
            );
          default:
            return <Fragment key={index}>{span.text}</Fragment>;
        }
      })}
    </>
  );
}

/** 代码块：带语言标签与复制按钮；未闭合时显示流式指示。 */
function CodeBlock({ lang, text, closed }: { lang: string; text: string; closed: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className={`md-code-block ${closed ? '' : 'is-streaming'}`}>
      <div className="md-code-head">
        <span>{lang || 'text'}</span>
        <button
          className="md-code-copy"
          onClick={() => {
            // 桌面端显式走 Tauri 原生插件，确保按钮复制的代码进入 Windows 系统剪贴板及其历史。
            void writeClipboardText(text)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {
                // 剪贴板不可用时静默失败，不打断阅读。
              });
          }}
          type="button"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

/** 对齐方式转内联样式；null 不写，交给 CSS 默认左对齐。 */
function alignStyle(align: 'left' | 'center' | 'right' | null) {
  return align ? { textAlign: align } : undefined;
}

/**
 * 渲染 Markdown。解析结果按内容缓存，流式追加时只在文本真正变化后重算。
 */
export function MarkdownView({ source }: { source: string }) {
  const nodes = useMemo(() => parseMarkdown(source), [source]);

  return (
    <div className="md-body">
      {nodes.map((node: MarkdownNode, index) => {
        switch (node.type) {
          case 'heading': {
            const Tag = `h${Math.min(node.level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
            return (
              <Tag key={index} className="md-heading">
                <InlineSpans spans={node.spans} />
              </Tag>
            );
          }
          case 'code':
            return <CodeBlock key={index} closed={node.closed} lang={node.lang} text={node.text} />;
          case 'list':
            return node.ordered ? (
              // 列表被说明段落分隔时会形成多个 ol，必须沿用 Markdown 原文序号，避免每段都显示为 1。
              <ol key={index} className="md-list" start={node.start}>
                {node.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <InlineSpans spans={item} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={index} className="md-list">
                {node.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <InlineSpans spans={item} />
                  </li>
                ))}
              </ul>
            );
          case 'quote':
            return (
              <blockquote key={index} className="md-quote">
                <InlineSpans spans={node.spans} />
              </blockquote>
            );
          case 'table':
            // 用 div 包裹实现窄侧栏下的横向滚动；单元格长内容靠 overflow-wrap 折行。
            return (
              <div key={index} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>
                      {node.headers.map((header, headerIndex) => (
                        <th key={headerIndex} style={alignStyle(node.aligns[headerIndex])}>
                          <InlineSpans spans={header} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {node.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} style={alignStyle(node.aligns[cellIndex])}>
                            <InlineSpans spans={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'divider':
            return <hr key={index} className="md-divider" />;
          default:
            return (
              <p key={index} className="md-paragraph">
                <InlineSpans spans={node.spans} />
              </p>
            );
        }
      })}
    </div>
  );
}
