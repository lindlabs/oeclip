import type { ButtonHTMLAttributes } from "react";
import type { IconName } from "./Icon";
import { Icon } from "./Icon";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  label: string;
}

export function IconButton({ icon, label, className = "", ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      title={props.title ?? label}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}
