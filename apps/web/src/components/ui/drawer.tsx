"use client";

import { Dialog as DrawerPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function Drawer({ ...props }: DrawerPrimitive.Root.Props) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({
  className,
  style,
  ...props
}: DrawerPrimitive.Backdrop.Props) {
  return (
    <DrawerPrimitive.Backdrop
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/20 backdrop-blur-[2px] transition-opacity duration-150 ease-[var(--ease-out)] data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="drawer-overlay"
      style={{
        WebkitBackdropFilter: "blur(2px)",
        backdropFilter: "blur(2px)",
        ...style,
      }}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DrawerPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center">
        <DrawerPrimitive.Popup
          className={cn(
            "pointer-events-auto relative flex max-h-[90dvh] w-full origin-bottom flex-col overflow-hidden rounded-t-xl bg-popover text-sm text-popover-foreground shadow-[0_-24px_80px_-24px_rgb(0_0_0/0.35),0_-8px_24px_-12px_rgb(0_0_0/0.18)] ring-1 ring-foreground/10 outline-none transition-[opacity,transform] duration-200 ease-[var(--ease-out)] data-ending-style:translate-y-4 data-ending-style:opacity-0 data-starting-style:translate-y-4 data-starting-style:opacity-0",
            className,
          )}
          data-slot="drawer-popup"
          {...props}
        >
          <div
            aria-hidden="true"
            className="flex h-5 shrink-0 items-end justify-center pt-2"
            data-slot="drawer-swipe-handle"
          >
            <span className="h-1 w-12 rounded-full bg-muted-foreground/30" />
          </div>
          {children}
          {showCloseButton ? (
            <DrawerPrimitive.Close
              data-slot="drawer-close"
              render={
                <Button
                  className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DrawerPrimitive.Close>
          ) : null}
        </DrawerPrimitive.Popup>
      </div>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1.5 border-b border-border/70 px-5 py-4 pr-14",
        className,
      )}
      data-slot="drawer-header"
      {...props}
    />
  );
}

function DrawerBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-5", className)}
      data-slot="drawer-body"
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-border/70 bg-muted/30 px-5 py-3.5",
        className,
      )}
      data-slot="drawer-footer"
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      className={cn(
        "font-heading text-lg leading-6 font-semibold tracking-tight",
        className,
      )}
      data-slot="drawer-title"
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      className={cn(
        "max-w-md text-sm leading-5 text-muted-foreground",
        className,
      )}
      data-slot="drawer-description"
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
};
