import { render as renderView } from "@testing-library/react";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/toast";

export function render(view: ReactNode) {
  return renderView(view, { wrapper: Toaster });
}
