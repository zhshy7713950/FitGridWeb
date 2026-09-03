export function isolateOutsideModal(layer: HTMLElement): () => void {
  const isolated: Array<{
    element: HTMLElement;
    ariaHidden: string | null;
    hadInert: boolean;
  }> = [];
  let branch: HTMLElement = layer;

  while (branch !== document.body && branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      if (sibling.hasAttribute("inert") && sibling.getAttribute("aria-hidden") === "true") {
        continue;
      }
      isolated.push({
        element: sibling,
        ariaHidden: sibling.getAttribute("aria-hidden"),
        hadInert: sibling.hasAttribute("inert"),
      });
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    }
    branch = parent;
  }

  return () => {
    for (const { element, ariaHidden, hadInert } of isolated) {
      if (hadInert) element.setAttribute("inert", "");
      else element.removeAttribute("inert");
      if (ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", ariaHidden);
    }
  };
}

export function lockDocumentForModal(layer: HTMLElement): () => void {
  const previousOverflow = document.body.style.overflow;
  const restoreIsolation = isolateOutsideModal(layer);
  document.body.style.overflow = "hidden";

  return () => {
    document.body.style.overflow = previousOverflow;
    restoreIsolation();
  };
}
