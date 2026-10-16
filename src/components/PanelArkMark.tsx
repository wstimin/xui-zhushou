import type { SVGProps } from 'react';

type PanelArkMarkProps = Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> & {
  size?: number | string;
};

/** The single source of truth for the PanelArk brand symbol. */
export function PanelArkMark({ size = 24, className = '', ...props }: PanelArkMarkProps) {
  return (
    <svg
      {...props}
      aria-hidden={props['aria-label'] ? undefined : true}
      className={`panelark-symbol ${className}`.trim()}
      data-panelark-mark=""
      height={size}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4.66 4.25h10.76c3.05 0 4.91 1.52 4.91 4.08 0 3.18-2.58 5.12-6.16 5.12h-3.75l-1.83 6.3H4.03L7.5 8H3.53l1.13-3.75Zm6.75 3.75-.58 1.98h3.67c.82 0 1.36-.43 1.36-1.08 0-.58-.44-.9-1.18-.9h-3.27Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
