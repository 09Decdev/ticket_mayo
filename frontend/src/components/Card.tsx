import { HTMLAttributes, PropsWithChildren } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
}

export function Card({ title, children, className, ...rest }: PropsWithChildren<CardProps>) {
  return (
    <div className={`card${className ? ' ' + className : ''}`} {...rest}>
      {title && <h3>{title}</h3>}
      {children}
    </div>
  );
}
