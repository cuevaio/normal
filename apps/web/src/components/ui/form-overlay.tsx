"use client";

import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";

const MOBILE_BREAKPOINT = 768;

type FormOverlayMode = "dialog" | "drawer" | "pending";

const FormOverlayModeContext = createContext<FormOverlayMode>("pending");

function useFormOverlayMode() {
  return useContext(FormOverlayModeContext);
}

function FormOverlay({
  children,
  defaultOpen,
  onOpenChange,
  open,
}: {
  readonly children?: ReactNode;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly open?: boolean;
}) {
  const [mode, setMode] = useState<Exclude<FormOverlayMode, "pending"> | null>(
    null,
  );

  useEffect(() => {
    setMode(window.innerWidth < MOBILE_BREAKPOINT ? "drawer" : "dialog");
  }, []);

  const handleOpenChange = (next: boolean) => onOpenChange?.(next);

  if (mode === null) {
    return (
      <FormOverlayModeContext.Provider value="pending">
        {children}
      </FormOverlayModeContext.Provider>
    );
  }

  return (
    <FormOverlayModeContext.Provider value={mode}>
      {mode === "drawer" ? (
        <Drawer
          defaultOpen={defaultOpen}
          onOpenChange={handleOpenChange}
          open={open}
        >
          {children}
        </Drawer>
      ) : (
        <Dialog
          defaultOpen={defaultOpen}
          onOpenChange={handleOpenChange}
          open={open}
        >
          {children}
        </Dialog>
      )}
    </FormOverlayModeContext.Provider>
  );
}

function FormOverlayTrigger(props: ComponentProps<typeof DialogTrigger>) {
  const mode = useFormOverlayMode();
  if (mode === "pending") {
    return (
      <Button disabled type="button">
        {props.children}
      </Button>
    );
  }
  return mode === "drawer" ? (
    <DrawerTrigger {...props} />
  ) : (
    <DialogTrigger {...props} />
  );
}

function FormOverlayClose(props: ComponentProps<typeof DialogClose>) {
  const mode = useFormOverlayMode();
  if (mode === "pending") {
    return null;
  }
  return mode === "drawer" ? (
    <DrawerClose {...props} />
  ) : (
    <DialogClose {...props} />
  );
}

function FormOverlayContent({
  children,
  className,
  showCloseButton,
}: {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly showCloseButton?: boolean;
}) {
  const mode = useFormOverlayMode();
  if (mode === "pending") {
    return null;
  }
  return mode === "drawer" ? (
    <DrawerContent
      className={className}
      {...(showCloseButton === undefined ? {} : { showCloseButton })}
    >
      {children}
    </DrawerContent>
  ) : (
    <DialogContent
      className={className}
      {...(showCloseButton === undefined ? {} : { showCloseButton })}
    >
      {children}
    </DialogContent>
  );
}

function FormOverlayHeader(props: ComponentProps<typeof DialogHeader>) {
  const mode = useFormOverlayMode();
  return mode === "drawer" ? (
    <DrawerHeader {...props} />
  ) : (
    <DialogHeader {...props} />
  );
}

function FormOverlayBody(props: ComponentProps<typeof DialogBody>) {
  const mode = useFormOverlayMode();
  return mode === "drawer" ? (
    <DrawerBody {...props} />
  ) : (
    <DialogBody {...props} />
  );
}

function FormOverlayFooter(props: ComponentProps<typeof DialogFooter>) {
  const mode = useFormOverlayMode();
  return mode === "drawer" ? (
    <DrawerFooter {...props} />
  ) : (
    <DialogFooter {...props} />
  );
}

function FormOverlayTitle(props: ComponentProps<typeof DialogTitle>) {
  const mode = useFormOverlayMode();
  return mode === "drawer" ? (
    <DrawerTitle {...props} />
  ) : (
    <DialogTitle {...props} />
  );
}

function FormOverlayDescription(
  props: ComponentProps<typeof DialogDescription>,
) {
  const mode = useFormOverlayMode();
  return mode === "drawer" ? (
    <DrawerDescription {...props} />
  ) : (
    <DialogDescription {...props} />
  );
}

export {
  FormOverlay,
  FormOverlayBody,
  FormOverlayClose,
  FormOverlayContent,
  FormOverlayDescription,
  FormOverlayFooter,
  FormOverlayHeader,
  FormOverlayTitle,
  FormOverlayTrigger,
};
