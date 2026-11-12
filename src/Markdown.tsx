import React, { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
function ManagedImage({ src, alt }: { src?: string; alt?: string }) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setUrl("");
    setError("");
    if (src?.startsWith("attachment:"))
      window.desktop
        .invoke("attachment.read", { id: src.slice(11) })
        .then((r) => {
          if (active) setUrl(`data:${r.mime};base64,${r.data}`);
        })
        .catch(() => {
          if (active) setError("附件缺失");
        });
    else
      setError(
        /^https?:/.test(src || "")
          ? "外部图片链接（导出保留原链接）"
          : "附件缺失或未导入",
      );
    return () => {
      active = false;
    };
  }, [src]);
  return url ? (
    <img src={url} alt={alt || "笔记图片"} loading="lazy" />
  ) : (
    <span className="missing-image">
      [{error || "加载图片…"}：{alt || src}]
    </span>
  );
}
export const Markdown = React.memo(function Markdown({
  children,
}: {
  children: string;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { trust: false, strict: "warn" }]]}
        urlTransform={(url) =>
          /^(attachment:|https?:|#)/.test(url) ? url : ""
        }
        components={{
          a: ({ children, href }) => (
            <span className="safe-link" title={href}>
              {children}
            </span>
          ),
          img: ManagedImage,
        }}
      >
        {children.replaceAll("<!-- generated-sources -->", "")}
      </ReactMarkdown>
    </div>
  );
});
