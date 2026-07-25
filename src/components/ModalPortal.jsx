import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableElements(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((element) => element.getAttribute('aria-hidden') !== 'true' && !element.hidden);
}

export default function ModalPortal({ children, ariaLabel, onEscape }) {
  const layerRef = useRef(null);
  const escapeRef = useRef(onEscape);
  const modalRoot = document.getElementById('modal-root');

  if (!modalRoot) {
    throw new Error('ModalPortal requires #modal-root in index.html');
  }

  useEffect(() => {
    escapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    const layer = layerRef.current;
    const previouslyFocused = document.activeElement;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && escapeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = getFocusableElements(layer);
      if (focusable.length === 0) {
        event.preventDefault();
        layer.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !layer.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const animationFrame = requestAnimationFrame(() => {
      const [firstFocusable] = getFocusableElements(layer);
      (firstFocusable || layer).focus();
    });
    layer.addEventListener('keydown', handleKeyDown, true);

    return () => {
      cancelAnimationFrame(animationFrame);
      layer.removeEventListener('keydown', handleKeyDown, true);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  return createPortal(
    <div
      ref={layerRef}
      className="modal-portal-layer"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
    >
      {children}
    </div>,
    modalRoot,
  );
}
