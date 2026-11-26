import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconChevronUp } from "../../../components/icons";
import { Button } from "../../../components/ui";
import { disclosureKey, useAutomaticDisclosure } from "./disclosure";
import { useMessageRevealRequest } from "./shared";

export function CollapsibleUserText({ messageId, dir, children }: {
  messageId: string;
  dir?: "ltr" | "rtl" | "auto";
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const contentId = useId();
  const previewRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const limitRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const request = useMessageRevealRequest(messageId);
  const { open, toggle, titleRef } = useAutomaticDisclosure(
    false, request, disclosureKey("user-text", messageId),
  );

  useLayoutEffect(() => {
    const text = textRef.current;
    const limit = limitRef.current;
    if (!text || !limit) return;
    const measure = () => {
      if (!text.clientWidth) return;
      // This probe uses the same CSS height as the preview clip.
      const previewHeight = limit.getBoundingClientRect().height;
      if (previewHeight > 0) setOverflowing(text.getBoundingClientRect().height > previewHeight + 0.5);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    observer.observe(limit);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="user-text-disclosure" data-collapsed={overflowing && !open ? "true" : undefined}>
      <div className="user-text-preview" ref={previewRef}>
        <div className="user-text-preview-limit" ref={limitRef} aria-hidden="true" />
        <div
          id={contentId}
          ref={textRef}
          className="message-user-text selectable"
          dir={dir}
          onFocusCapture={(event) => {
            const preview = previewRef.current;
            if (preview && overflowing && !open &&
              event.target.getBoundingClientRect().bottom > preview.getBoundingClientRect().bottom) toggle();
          }}
        >
          {children}
        </div>
      </div>
      {overflowing ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="user-text-toggle"
          ref={titleRef}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={toggle}
        >
          {t(open ? "chat.subagentTaskCollapse" : "chat.subagentTaskExpand")}
          {open ? <IconChevronUp size={14} aria-hidden /> : <IconChevronDown size={14} aria-hidden />}
        </Button>
      ) : null}
    </div>
  );
}
