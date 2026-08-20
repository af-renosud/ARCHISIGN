import {
  type HTMLAttributes,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const SIGNATURE_FONT_FAMILY = "'Satisfy', cursive";

type FittedSignatureTextProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  text: string;
  maxFontSize?: number;
};

export function FittedSignatureText({
  text,
  maxFontSize = 18,
  className = "",
  style,
  ...props
}: FittedSignatureTextProps) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState(maxFontSize);

  const fitText = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;

    const computed = window.getComputedStyle(element);
    const horizontalPadding =
      Number.parseFloat(computed.paddingLeft || "0") +
      Number.parseFloat(computed.paddingRight || "0");
    const availableWidth = Math.max(0, element.clientWidth - horizontalPadding);
    if (availableWidth <= 0 || !text) {
      setFontSize(maxFontSize);
      return;
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return;
    context.font = `${maxFontSize}px ${SIGNATURE_FONT_FAMILY}`;
    const measuredWidth = context.measureText(text).width;
    const nextSize = measuredWidth > availableWidth
      ? maxFontSize * (availableWidth / measuredWidth)
      : maxFontSize;
    setFontSize(Number.isFinite(nextSize) && nextSize > 0 ? nextSize : maxFontSize);
  }, [maxFontSize, text]);

  useLayoutEffect(() => {
    fitText();
  }, [fitText]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(fitText);
    observer?.observe(element);

    void document.fonts?.load(`${maxFontSize}px Satisfy`).then(fitText);
    return () => observer?.disconnect();
  }, [fitText, maxFontSize]);

  return (
    <span
      ref={elementRef}
      className={`block w-full whitespace-nowrap overflow-hidden text-ellipsis ${className}`}
      style={{
        ...style,
        color: style?.color ?? "#0F2C59",
        fontFamily: SIGNATURE_FONT_FAMILY,
        fontSize,
      }}
      title={props.title ?? text}
      {...props}
    >
      {text}
    </span>
  );
}