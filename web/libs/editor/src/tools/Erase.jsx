import { observer } from "mobx-react";
import { types } from "mobx-state-tree";

import BaseTool from "./Base";
import ToolMixin from "../mixins/Tool";
import Canvas from "../utils/canvas";
import { clamp, findClosestParent } from "../utils/utilities";
import { DrawingTool } from "../mixins/DrawingTool";
import { IconEraserTool } from "@humansignal/icons";
import { Tool } from "../components/Toolbar/Tool";
import { Range } from "../common/Range/Range";

const MIN_SIZE = 1;
const MAX_SIZE = 50;

// Debug logging function that always works
const DEBUG = false;
function debugLog(...args) {
  if (DEBUG) {
    // Use both console.log and console.warn to ensure visibility
    console.log(`[ERASER-DEBUG]`, ...args);
    // Also use console.warn which is often displayed even when logs are filtered
    console.warn(`[ERASER-DEBUG]`, ...args);
  }
}

const IconDot = ({ size }) => {
  return (
    <span
      style={{
        display: "block",
        width: size,
        height: size,
        background: "rgba(0, 0, 0, 0.25)",
        borderRadius: "100%",
      }}
    />
  );
};

const ToolView = observer(({ item }) => {
  return (
    <Tool
      label="Eraser"
      ariaLabel="eraser"
      shortcut="E"
      active={item.selected}
      extraShortcuts={item.extraShortcuts}
      tool={item}
      disabled={!item.getSelectedShape}
      onClick={() => {
        if (item.selected) return;

        item.manager.selectTool(item, true);
      }}
      icon={item.iconClass}
      controls={item.controls}
    />
  );
});

const _Tool = types
  .model("EraserTool", {
    strokeWidth: types.optional(types.number, 10),
    group: "segmentation",
    unselectRegionOnToolChange: false,
  })
  .volatile(() => ({
    index: 9999,
    canInteractWithRegions: false,
    // Pointer event tracking
    pointerIsDown: false,
    lastPointerPosition: { x: 0, y: 0 },
    isPencilDown: false,
    // Touch event tracking
    activeSource: null,
    touchId: null,
    lastX: 0,
    lastY: 0,
    directTouchHandlers: null
  }))
  .views((self) => ({
    get viewClass() {
      return () => <ToolView item={self} />;
    },
    get iconComponent() {
      return IconEraserTool;
    },
    get controls() {
      return [
        <Range
          key="eraser-size"
          value={self.strokeWidth}
          min={MIN_SIZE}
          max={MAX_SIZE}
          reverse
          align="vertical"
          minIcon={<IconDot size={8} />}
          maxIcon={<IconDot size={16} />}
          onChange={(value) => {
            self.setStroke(value);
          }}
        />,
      ];
    },
    get extraShortcuts() {
      return {
        "[": [
          "Decrease size",
          () => {
            self.setStroke(clamp(self.strokeWidth - 5, MIN_SIZE, MAX_SIZE));
          },
        ],
        "]": [
          "Increase size",
          () => {
            self.setStroke(clamp(self.strokeWidth + 5, MIN_SIZE, MAX_SIZE));
          },
        ],
      };
    },
  }))
  .actions((self) => {
    let brush;
    // Keep a reference to the event listeners so we can remove them later
    let pointerEventListeners = null;

    // Function to dump info about the event for debugging
    function dumpEvent(prefix, ev) {
      debugLog(`${prefix} EVENT:`, {
        type: ev.type,
        touches: ev.touches ? Array.from(ev.touches).map(t => ({ id: t.identifier, x: t.clientX, y: t.clientY })) : "no touches",
        target: ev.target ? ev.target.tagName || "unknown" : "no target",
        x: ev.clientX,
        y: ev.clientY
      });
    }

    return {
      setActiveSource(source) {
        self.activeSource = source;
      },
      
      setTouchId(id) {
        self.touchId = id;
      },
      
      updateLastCoordinates(x, y) {
        self.lastX = x;
        self.lastY = y;
      },
      
      getCanvasCoordinates(e, specificTouch) {
        if (!self.obj?.stageRef) return null;
        
        const stage = self.obj.stageRef;
        const container = stage.container();
        const rect = container.getBoundingClientRect();
        
        let clientX, clientY;
        
        if (specificTouch) {
          // Use specific touch if provided
          clientX = specificTouch.clientX;
          clientY = specificTouch.clientY;
        } else if (e.touches && e.touches.length > 0) {
          // Use first touch
          clientX = e.touches[0].clientX;
          clientY = e.touches[0].clientY;
        } else if (e.changedTouches && e.changedTouches.length > 0) {
          // Use first changed touch (for touchend)
          clientX = e.changedTouches[0].clientX;
          clientY = e.changedTouches[0].clientY;
        } else if (e.clientX !== undefined) {
          // Use mouse coordinates
          clientX = e.clientX;
          clientY = e.clientY;
        } else {
          return null;
        }
        
        // Convert to canvas coordinates
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        
        // Store last position for touchend/touchcancel
        self.lastX = x;
        self.lastY = y;
        self.updateLastCoordinates(x, y);
        return [x, y];
      },

      updateCursor() {
        self.addDirectTouchHandlers();
        if (!self.selected || !self.obj?.stageRef) return;
        const val = 24;
        const stage = self.obj.stageRef;
        const base64 = Canvas.brushSizeCircle(val);
        const cursor = ["url('", base64, "')", " ", Math.floor(val / 2) + 4, " ", Math.floor(val / 2) + 4, ", auto"];

        stage.container().style.cursor = cursor.join("");
      },

      // Setup dedicated pointer event listeners for Apple Pencil
      setupPointerEvents() {
        if (!self.obj?.stageRef) return;
        
        const container = self.obj.stageRef.container();
        
        // Remove any existing listeners to prevent duplicates
        self.removePointerEvents();
        
        // Store references to the bound event handlers so we can remove them later
        const handlers = {
          pointerdown: self.handlePointerDown.bind(self),
          pointermove: self.handlePointerMove.bind(self),
          pointerup: self.handlePointerUp.bind(self),
          pointercancel: self.handlePointerUp.bind(self),
          pointerleave: self.handlePointerUp.bind(self)
        };
        
        // Add event listeners with passive: false to allow preventDefault
        Object.entries(handlers).forEach(([event, handler]) => {
          container.addEventListener(event, handler, { passive: false });
        });
        
        // Store references to remove later
        pointerEventListeners = handlers;
        
        console.log("Pointer event listeners set up for Apple Pencil support");
      },
      
      // Remove event listeners when tool is deselected
      removePointerEvents() {
        if (!self.obj?.stageRef || !pointerEventListeners) return;
        
        const container = self.obj.stageRef.container();
        
        // Remove all registered event listeners
        Object.entries(pointerEventListeners).forEach(([event, handler]) => {
          container.removeEventListener(event, handler);
        });
        
        pointerEventListeners = null;
        console.log("Pointer event listeners removed");
      },
      
      // Apple Pencil specific setup
      afterSelect() {
        self.setupPointerEvents();
      },
      
      afterDeselect() {
        debugLog("Tool deselected - cleaning up");
        
        // Remove pointer events
        self.removePointerEvents();
        
        // Remove direct touch handlers
        self.removeDirectTouchHandlers();
        
        // Reset all state
        self.setActiveSource(null);
        self.setTouchId(null);
        self.pointerIsDown = false;
        self.isPencilDown = false;
      },
      
      // Pointer event handlers for Apple Pencil
      handlePointerDown(e) {
        // Check if this is an Apple Pencil event (pointerType === 'pen')
        const isPencil = e.pointerType === 'pen';
        
        // For debugging
        console.log(`Pointer down: ${e.pointerType}, isPencil: ${isPencil}, pressure: ${e.pressure}`);
        
        // Store the current pointer state
        self.pointerIsDown = true;
        self.isPencilDown = isPencil;
        
        // Skip regular handling if not allowed
        if (!self.isAllowedInteraction(e)) {
          console.log("Interaction not allowed");
          return;
        }
        
        // Konva stage coordinates
        const stage = self.obj.stageRef;
        const point = stage.getPointerPosition();
        
        if (!point) {
          console.log("No point position found");
          return;
        }
        
        // Store for move events
        self.lastPointerPosition = { x: point.x, y: point.y };
        
        // Don't let event propagate to prevent conflicts
        e.preventDefault();
        e.stopPropagation();
        
        // Handle the drawing with our coordinates
        self.startErasing(point.x, point.y, e);
      },
      
      handlePointerMove(e) {
        // Only process if pointer is down
        if (!self.pointerIsDown) return;
        
        // Only process Apple Pencil events if that's what started the drawing
        if (self.isPencilDown && e.pointerType !== 'pen') return;
        
        // Skip if not in drawing mode
        if (self.mode !== "drawing") return;
        
        // Konva stage coordinates
        const stage = self.obj.stageRef;
        const point = stage.getPointerPosition();
        
        if (!point) return;
        
        // Don't let event propagate
        e.preventDefault();
        e.stopPropagation();
        
        // Add a point on the path
        self.addPoint(point.x, point.y);
        
        // Store position
        self.lastPointerPosition = { x: point.x, y: point.y };
      },
      
      handlePointerUp(e) {
        // Skip if not drawing or if it's a different pointer type than what started the drawing
        if (self.mode !== "drawing" || (self.isPencilDown && e.pointerType !== 'pen')) {
          self.pointerIsDown = false;
          self.isPencilDown = false;
          return;
        }
        
        // Konva stage coordinates
        const stage = self.obj.stageRef;
        const point = stage.getPointerPosition() || self.lastPointerPosition;
        
        // Don't let event propagate
        e.preventDefault();
        e.stopPropagation();
        
        // Finish the drawing
        self.finishErasing(point.x, point.y);
        
        // Reset pointer states
        self.pointerIsDown = false;
        self.isPencilDown = false;
      },
      
      // Add direct touch event handlers at the window level
      addDirectTouchHandlers() {
        if (self.directTouchHandlers) return;
        
        debugLog("Adding direct touch handlers");
        
        // Create a function that will be called from handlers but uses actions
        const handleTouchStart = (e) => {
          if (!self.selected) return;
          
          // Check if the touch is within our canvas before preventing default
          const container = self.obj?.stageRef?.container();
          if (!container) return;
          
          // Only handle events that are within our drawing canvas
          let isWithinCanvas = false;
          if (e.target) {
            // Check if the target is our canvas or within it
            isWithinCanvas = e.target === container || 
                             container.contains(e.target) ||
                             // Also check for Konva's content node
                             (self.obj?.stageRef?.content && 
                              (e.target === self.obj.stageRef.content || 
                               self.obj.stageRef.content.contains(e.target)));
          }
          
          // Only process events within our canvas
          if (!isWithinCanvas) {
            debugLog("Touch outside canvas - ignoring");
            return;
          }
          
          dumpEvent("DIRECT TOUCH START", e);
          e.preventDefault();
          e.stopPropagation();
          
          // Skip if already drawing with a different input source
          if (self.activeSource && self.activeSource !== 'touch') return;
          
          // Set touch as active input source and store touch ID using actions
          self.setActiveSource('touch');
          if (e.touches && e.touches.length > 0) {
            self.setTouchId(e.touches[0].identifier);
          }
          
          // Get coordinates relative to canvas
          const coords = self.getCanvasCoordinates(e);
          if (!coords) return;
          
          // Start erasing
          self.startErasing(coords[0], coords[1], e);
        };
        
        const handleTouchMove = (e) => {
          if (!self.selected) return;
          if (self.activeSource !== 'touch' || self.mode !== "drawing") return;
          
          dumpEvent("DIRECT TOUCH MOVE", e);
          e.preventDefault();
          e.stopPropagation();
          
          // Verify it's the same touch we started with
          if (e.touches) {
            let found = false;
            for (let i = 0; i < e.touches.length; i++) {
              if (e.touches[i].identifier === self.touchId) {
                found = true;
                break;
              }
            }
            if (!found) return;
          }
          
          // Get coordinates relative to canvas
          const coords = self.getCanvasCoordinates(e);
          if (!coords) return;
          
          // Add point to drawing
          self.addPoint(coords[0], coords[1]);
        };
        
        const handleTouchEnd = (e) => {
          if (!self.selected || self.activeSource !== 'touch') return;
          
          // Skip if not using touch
          if (self.activeSource !== 'touch') return;
          
          dumpEvent("DIRECT TOUCH END", e);
          if (self.mode === "drawing") {
            e.preventDefault();
            e.stopPropagation();
          }
          
          
          // Check if our touch has ended
          let touchEnded = true;
          if (e.touches) {
            for (let i = 0; i < e.touches.length; i++) {
              if (e.touches[i].identifier === self.touchId) {
                touchEnded = false;
                break;
              }
            }
          }
          
          // If our touch ended and we were drawing, finish
          if (touchEnded && self.mode === "drawing") {
            // Get coordinates from changedTouches since the touch is no longer active
            let coords;
            if (e.changedTouches) {
              for (let i = 0; i < e.changedTouches.length; i++) {
                if (e.changedTouches[i].identifier === self.touchId) {
                  coords = self.getCanvasCoordinates(e, e.changedTouches[i]);
                  break;
                }
              }
            }
            
            // If we couldn't find coordinates, use last known position
            if (!coords) {
              coords = [self.lastX || 0, self.lastY || 0];
            }
            
            self.finishErasing(coords[0], coords[1]);
            self.setActiveSource(null);
            self.setTouchId(null);
          }
        };
        
        const handleTouchCancel = (e) => {
          if (!self.selected || self.activeSource !== 'touch') return;
          
          // Skip if not using touch
          if (self.activeSource !== 'touch') return;
          
          dumpEvent("DIRECT TOUCH CANCEL", e);
          if (self.mode === "drawing") {
            e.preventDefault();
            e.stopPropagation();
          }
          
          // If we were drawing, finish
          if (self.mode === "drawing") {
            const coords = [self.lastX || 0, self.lastY || 0];
            self.finishErasing(coords[0], coords[1]);
          }
          
          self.setActiveSource(null);
          self.setTouchId(null);
        };
        
        // Create event handler objects
        const handlers = {
          touchstart: handleTouchStart,
          touchmove: handleTouchMove,
          touchend: handleTouchEnd,
          touchcancel: handleTouchCancel
        };
        
        // Get the container element if available
        const container = self.obj?.stageRef?.container() || document;
        
        // Add event listeners
        container.addEventListener("touchstart", handlers.touchstart, { passive: false, capture: true });
        window.addEventListener("touchmove", handlers.touchmove, { passive: false, capture: true });
        window.addEventListener("touchend", handlers.touchend, { passive: false, capture: true });
        window.addEventListener("touchcancel", handlers.touchcancel, { passive: false, capture: true });
        
        // Store handlers for removal later
        self.directTouchHandlers = {
          element: container,
          handlers: handlers
        };
      },
      
      // Remove direct touch handlers
      removeDirectTouchHandlers() {
        if (!self.directTouchHandlers) return;
        
        const { element, handlers } = self.directTouchHandlers;
        
        // Remove event listeners
        element.removeEventListener("touchstart", handlers.touchstart, { capture: true });
        window.removeEventListener("touchmove", handlers.touchmove, { capture: true });
        window.removeEventListener("touchend", handlers.touchend, { capture: true });
        window.removeEventListener("touchcancel", handlers.touchcancel, { capture: true });
        
        self.directTouchHandlers = null;
        
        debugLog("Direct touch handlers removed");
      },

      afterUpdateSelected() {
        self.updateCursor();
      },

      addPoint(x, y) {
        if (brush && brush.type === "brushregion") {
          brush.addPoint(Math.floor(x), Math.floor(y));
        }
      },

      setStroke(val) {
        self.strokeWidth = val;
      },
      
      // Centralized functions for erasing operations
      startErasing(x, y, originalEvent) {
        brush = self.getSelectedShape;
        if (!brush) return;
        
        if (brush && brush.type === "brushregion") {
          self.mode = "drawing";
          brush.beginPath({
            type: "eraser",
            opacity: 1,
            strokeWidth: self.strokeWidth,
          });
          self.addPoint(x, y);
        }
      },
      
      finishErasing(x, y) {
        if (self.mode !== "drawing") return;
        
        self.mode = "viewing";
        
        if (brush) {
          brush.endPath();
        }
      },

      // Original mouse event handlers - now delegate to centralized functions
      mouseupEv() {
        if (self.mode !== "drawing") return;
        
        // If Apple Pencil interaction is in progress, don't process mouse events
        if (self.isPencilDown) return;
        
        self.finishErasing();
      },

      mousemoveEv(ev, _, [x, y]) {
        if (self.mode !== "drawing") return;
        
        // If Apple Pencil interaction is in progress, don't process mouse events
        if (self.isPencilDown) return;
        
        if (
          !findClosestParent(
            ev.target,
            (el) => el === self.obj.stageRef.content,
            (el) => el.parentElement,
          )
        )
          return;

        if (brush?.type === "brushregion") {
          self.addPoint(x, y);
        }
      },

      mousedownEv(ev, _, [x, y]) {
        if (!self.isAllowedInteraction(ev)) return;
        
        // If Apple Pencil interaction is in progress, don't process mouse events
        if (self.isPencilDown) return;
        
        if (
          !findClosestParent(
            ev.target,
            (el) => el === self.obj.stageRef.content,
            (el) => el.parentElement,
          )
        )
          return;

        self.startErasing(x, y, ev);
      },
    };
  });

const Erase = types.compose(_Tool.name, ToolMixin, BaseTool, DrawingTool, _Tool);

export { Erase };