// Fix for Brush Tool with Flood Fill functionality
// The key issue is in the commitDrawingRegion method and how regions maintain their labels

import { observer } from "mobx-react";
import { types } from "mobx-state-tree";

import BaseTool from "./Base";
import ToolMixin from "../mixins/Tool";
import Canvas from "../utils/canvas";
import { clamp, findClosestParent } from "../utils/utilities";
import { DrawingTool } from "../mixins/DrawingTool";
import { Tool } from "../components/Toolbar/Tool";
import { Range } from "../common/Range/Range";
import { NodeViews } from "../components/Node/Node";

const MIN_SIZE = 1;
const MAX_SIZE = 50;

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
      label="Brush"
      ariaLabel="brush-tool"
      active={item.selected}
      shortcut={item.shortcut}
      extraShortcuts={item.extraShortcuts}
      icon={item.iconClass}
      tool={item}
      onClick={() => {
        if (item.selected) return;
        item.manager.selectTool(item, true);
      }}
      controls={item.controls}
    />
  );
});

const _Tool = types
  .model("BrushTool", {
    strokeWidth: types.optional(types.number, 15),
    group: "segmentation",
    shortcut: "B",
    smart: true,
    unselectRegionOnToolChange: false,
    floodFillEnabled: types.optional(types.boolean, false),
  })
  .volatile(() => ({
    canInteractWithRegions: false,
    // Add this to store the current active label ID
    currentLabelId: null,
  }))
  .views((self) => ({
    get viewClass() {
      return () => <ToolView item={self} />;
    },
    get iconComponent() {
      return self.dynamic ? NodeViews.BrushRegionModel.altIcon : NodeViews.BrushRegionModel.icon;
    },
    get tagTypes() {
      return {
        stateTypes: "brushlabels",
        controlTagTypes: ["brushlabels", "brush"],
      };
    },
    get controls() {
      return [
        <Range
        onClick={() => alert("Click to toggle flood fill")}
          key="brush-size"
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
        <div 
          key="flood-fill-status" 
          style={{ 
            margin: '12px 0', 
            padding: '8px',
            borderRadius: '4px',
            backgroundColor: self.floodFillEnabled ? 'rgba(32, 128, 208, 0.1)' : '#f5f5f5',
            textAlign: 'center',
            fontSize: '12px',
          }}
          onClick={() => self.toggleFloodFill()}
        >
          <div>Flood Fill: {self.floodFillEnabled ? "ON" : "OFF"}</div>
          <div style={{ fontSize: '10px', marginTop: '4px', opacity: 0.7 }}>
            Press 'F' to toggle
          </div>
        </div>,
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
        "F": [
          "Toggle flood fill",
          () => {
            self.toggleFloodFill();
          },
        ],
      };
    },
  }))
  .actions((self) => {
    let brush;
    let isFirstBrushStroke;

    return {
      // Flood fill toggle and cursor update
      toggleFloodFill() {
        self.floodFillEnabled = !self.floodFillEnabled;
        self.updateCursor();
      },
      
      updateCursor() {
        if (!self.selected || !self.obj?.stageRef) return;
        const val = self.strokeWidth;
        const stage = self.obj.stageRef;
        
        if (self.floodFillEnabled) {
          // Use a paint bucket cursor when flood fill is enabled
          stage.container().style.cursor = "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\" viewBox=\"0 0 32 32\"><path fill=\"black\" d=\"M12 0L8 4H2v6l-2 4 4 10h10l6-2 4-8-4-8-8-6zm-2 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z\"/></svg>') 16 16, auto";
          // Fallback to crosshair if the SVG cursor doesn't work
          if (stage.container().style.cursor === "") {
            stage.container().style.cursor = "crosshair";
          }
        } else {
          // Use normal brush cursor
          const base64 = Canvas.brushSizeCircle(val);
          const cursor = ["url('", base64, "')", " ", Math.floor(val / 2) + 4, " ", Math.floor(val / 2) + 4, ", auto"];
          stage.container().style.cursor = cursor.join("");
        }
      },
      
      // Updated to store the current label ID
      onSelectLabel(labelId) {
        self.currentLabelId = labelId;
      },
      
      // Capture the current selected label when the tool is selected
      beforeUpdateSelected() {
        if (self.control && self.control.selectedLabels) {
          const selectedLabels = self.control.selectedLabels;
          if (selectedLabels.length > 0) {
            self.currentLabelId = selectedLabels[0];
          }
        }
      },
      
      // Function to detect enclosed shapes - fixed to avoid MobX deletion issues
      isPointInEnclosedShape(x, y) {
        try {
          // Get the current brush region
          const brushRegion = self.getSelectedShape;
          if (!brushRegion || brushRegion.type !== "brushregion") {
            console.log("No valid brush region found");
            return { inside: false };
          }
          
          // Check if touches exist
          if (!brushRegion.touches || brushRegion.touches.length === 0) {
            console.log("No touch data found");
            return { inside: false };
          }
          
          console.log(`Found ${brushRegion.touches.length} touches in the brush region`);
          
          // Check each touch object to find closed paths
          const closedPaths = [];
          
          for (let touchIndex = 0; touchIndex < brushRegion.touches.length; touchIndex++) {
            const touch = brushRegion.touches[touchIndex];
            if (!touch || !touch.points || touch.points.length < 6) {
              console.log(`Touch ${touchIndex} has insufficient points`);
              continue;
            }
            
            const points = touch.points;

            // Check if this path is closed
            const firstX = points[0];
            const firstY = points[1];
            const lastX = points[points.length - 2];
            const lastY = points[points.length - 1];
            
            const distance = Math.sqrt(
              Math.pow(lastX - firstX, 2) + 
              Math.pow(lastY - firstY, 2)
            );
            
            const isPathClosed = distance < 20; // Threshold for considering it closed
            console.log(`Touch ${touchIndex} closed:`, isPathClosed, "Distance:", distance);
            
            if (isPathClosed) {
              // Store the touchIndex and reference to the points but don't copy the array
              closedPaths.push({ touchIndex, points: points });
            }
          }
          
          console.log(`Found ${closedPaths.length} closed paths`);
          
          // Check if the point is inside any of the closed paths
          for (const path of closedPaths) {
            const points = path.points;
            
            // Use point-in-polygon algorithm to check
            let inside = false;
            for (let i = 0, j = points.length - 2; i < points.length; i += 2) {
              j = (i === 0) ? points.length - 2 : i - 2; // Connect to previous point
              
              const xi = points[i];
              const yi = points[i + 1];
              const xj = points[j];
              const yj = points[j + 1];
              
              const intersect = ((yi > y) !== (yj > y)) && 
                                (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
              
              if (intersect) {
                inside = !inside;
              }
            }
            
            if (inside) {
              console.log(`Point is inside closed path ${path.touchIndex}`);
              return { inside: true, pathIndex: path.touchIndex, points: points };
            }
          }
          
          console.log("Point is not inside any closed path");
          return { inside: false };
        } catch (err) {
          console.error("Error in isPointInEnclosedShape:", err);
          return { inside: false };
        }
      },
      
      // Fixed commitDrawingRegion to properly handle label preservation
      commitDrawingRegion() {
        try {
          const { currentArea, control, obj } = self;
          const source = currentArea.toJSON();
          
          if (!source || !currentArea.results || !currentArea.results[0]) {
            console.error("Invalid source or results in currentArea");
            return null;
          }
          
          const value = { coordstype: "px", touches: source.touches, dynamic: source.dynamic };
          
          // Get the current result's value to preserve label information
          const resultValue = currentArea.results[0].value.toJSON();
          
          // Create the new result with the preserved label information
          const newArea = self.annotation.createResult(value, resultValue, control, obj);
          
          currentArea.setDrawing(false);
          
          // Make sure we apply the correct label states
          self.applyActiveStates(newArea);
          
          // Fix: Make sure the currentLabelId is applied to the new region
          if (self.currentLabelId && newArea.states) {
            // Find the state that matches our stored label ID
            const matchingState = newArea.states.find(state => 
              state.type === "brushlabels" && state.value.id === self.currentLabelId
            );
            
            // If we found the matching state, select it
            if (matchingState) {
              newArea.states.forEach(s => {
                if (s === matchingState) {
                  s.setValue(true);
                } else if (s.type === "brushlabels") {
                  s.setValue(false);
                }
              });
            }
          }
          
          self.deleteRegion();
          newArea.notifyDrawingFinished();
          return newArea;
        } catch (err) {
          console.error("Error in commitDrawingRegion:", err);
          return null;
        }
      },

      // Fix: Add proper label handling when applying states
      applyActiveStates(area) {
        try {
          const states = self.control.states();
          
          if (!states || states.length === 0) return;
          
          // Use the stored currentLabelId if available
          const activeStates = self.currentLabelId 
            ? states.filter(s => s.id === self.currentLabelId)
            : states.filter(s => s.selected);
            
          activeStates.forEach(state => {
            area.setValue(state);
          });
        } catch (err) {
          console.error("Error applying active states:", err);
        }
      },

      setStroke(val) {
        self.strokeWidth = val;
      },

      afterUpdateSelected() {
        self.updateCursor();
      },

      addPoint(x, y) {
        brush.addPoint(Math.floor(x), Math.floor(y));
      },
      
      // Mouse event handlers
      mousedownEv(ev, _, [x, y]) {
        console.log("mousedownEv", x, y);
        if (!self.isAllowedInteraction(ev)) return;
        if (
          !findClosestParent(
            ev.target,
            (el) => el === self.obj.stageRef.content,
            (el) => el.parentElement,
          )
        )
          return;
        const c = self.control;
        const o = self.obj;
        
        // Store the current label ID for later use
        if (c.selectedLabels && c.selectedLabels.length > 0) {
          self.currentLabelId = c.selectedLabels[0];
        }

        brush = self.getSelectedShape;

        // prevent drawing when current image is
        // different from image where the brush was started
        if (o && brush && o.multiImage && o.currentImage !== brush.item_index) return;

        // Special handling for flood fill
        if (self.floodFillEnabled) {
          try {
            console.log("Flood fill clicked at:", { x, y });
            
            // Check if the point is inside an enclosed shape
            const result = self.isPointInEnclosedShape(x, y);
            
            // Initialize drawing
            if (brush && brush.type === "brushregion") {
              self.annotation.history.freeze();
              self.mode = "drawing";
              brush.setDrawing(true);
              self.obj.annotation.setIsDrawing(true);
              isFirstBrushStroke = false;
            } else {
              if (!self.canStartDrawing()) return;
              if (self.tagTypes.stateTypes === self.control.type && !self.control.isSelected) return;
              self.annotation.history.freeze();
              self.mode = "drawing";
              isFirstBrushStroke = true;
              self.obj.annotation.setIsDrawing(true);
              brush = self.createDrawingRegion({
                touches: [],
                coordstype: "px",
              });
            }
            
            // Begin path
            brush.beginPath({
              type: "add",
              strokeWidth: self.strokeWidth || c.strokeWidth,
            });
            
            if (result.inside) {
              console.log("Filling enclosed shape");
              
              const points = result.points;
              
              // Calculate bounding box of the shape (without modifying the array)
              let minX = Infinity, minY = Infinity;
              let maxX = -Infinity, maxY = -Infinity;
              
              for (let i = 0; i < points.length; i += 2) {
                const px = points[i];
                const py = points[i + 1];
                minX = Math.min(minX, px);
                minY = Math.min(minY, py);
                maxX = Math.max(maxX, px);
                maxY = Math.max(maxY, py);
              }
              
              // Add padding
              minX -= 5;
              minY -= 5;
              maxX += 5;
              maxY += 5;
              
              console.log("Bounding box:", { minX, minY, maxX, maxY });
              
              // Create a grid of points inside the shape
              const gridSize = Math.max(4, self.strokeWidth / 4);
              let pointsAdded = 0;
              const maxPoints = 5000; // Safety limit
              
              // Convert points to vertices format without modifying the array
              const vertices = [];
              for (let i = 0; i < points.length; i += 2) {
                vertices.push({ 
                  x: points[i], 
                  y: points[i + 1] 
                });
              }
              
              // Fill with a grid pattern
              for (let px = minX; px <= maxX && pointsAdded < maxPoints; px += gridSize) {
                for (let py = minY; py <= maxY && pointsAdded < maxPoints; py += gridSize) {
                  // Check if this point is inside the polygon
                  let inside = false;
                  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
                    const xi = vertices[i].x;
                    const yi = vertices[i].y;
                    const xj = vertices[j].x;
                    const yj = vertices[j].y;
                    
                    const intersect = ((yi > py) !== (yj > py)) && 
                                      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
                    
                    if (intersect) {
                      inside = !inside;
                    }
                  }
                  
                  if (inside) {
                    self.addPoint(px, py);
                    pointsAdded++;
                  }
                }
              }
              
              console.log(`Added ${pointsAdded} points inside the shape`);
            } else {
              console.log("Not inside an enclosed shape, using circle fill");
              
              // Fallback to simple circle fill if not inside a shape
              const radius = Math.max(self.strokeWidth * 3, 20);
              const numPoints = 24;
              
              for (let i = 0; i < numPoints; i++) {
                const angle = (i / numPoints) * Math.PI * 2;
                const px = x + Math.cos(angle) * radius;
                const py = y + Math.sin(angle) * radius;
                self.addPoint(px, py);
              }
              
              // Add some points inside the circle
              for (let i = 0; i < 20; i++) {
                const r = radius * Math.random() * 0.8;
                const angle = Math.random() * Math.PI * 2;
                const px = x + Math.cos(angle) * r;
                const py = y + Math.sin(angle) * r;
                self.addPoint(px, py);
              }
            }
            
            // End path and complete drawing
            brush.endPath();
            self.mode = "viewing";
            brush.setDrawing(false);
            
            if (isFirstBrushStroke) {
              // Let's make sure we don't try to access anything that might be deleted
              try {
                const newBrush = self.commitDrawingRegion();
                if (newBrush) {
                  try {
                    self.obj.annotation.selectArea(newBrush);
                  } catch (err) {
                    console.error("Error selecting area:", err);
                  }
                }
              } catch (err) {
                console.error("Error committing region:", err);
              }
            } else {
              // Make sure we commit changes even for existing regions
              try {
                self.commitDrawingRegion();
              } catch (err) {
                console.error("Error committing region:", err);
              }
            }
            
            self.annotation.history.unfreeze();
            self.obj.annotation.setIsDrawing(false);
          } catch (err) {
            console.error("Flood fill error:", err);
            console.error(err.stack);
            self.mode = "viewing";
            self.annotation.history.unfreeze();
            self.obj.annotation.setIsDrawing(false);
          }
          return;
        }
        
        // Original brush behavior when flood fill is not enabled
        if (brush && brush.type === "brushregion") {
          self.annotation.history.freeze();
          self.mode = "drawing";
          brush.setDrawing(true);
          self.obj.annotation.setIsDrawing(true);
          isFirstBrushStroke = false;
          brush.beginPath({
            type: "add",
            strokeWidth: self.strokeWidth || c.strokeWidth,
          });

          self.addPoint(x, y);
        } else {
          if (!self.canStartDrawing()) return;
          if (self.tagTypes.stateTypes === self.control.type && !self.control.isSelected) return;
          self.annotation.history.freeze();
          self.mode = "drawing";
          isFirstBrushStroke = true;
          self.obj.annotation.setIsDrawing(true);
          brush = self.createDrawingRegion({
            touches: [],
            coordstype: "px",
          });

          brush.beginPath({
            type: "add",
            strokeWidth: self.strokeWidth || c.strokeWidth,
          });

          self.addPoint(x, y);
        }
      },

      mousemoveEv(ev, _, [x, y]) {
        if (!self.isAllowedInteraction(ev)) return;
        if (self.mode !== "drawing") return;
        // Skip for flood fill mode
        if (self.floodFillEnabled) return;
        if (
          !findClosestParent(
            ev.target,
            (el) => el === self.obj.stageRef.content,
            (el) => el.parentElement,
          )
        )
          return;
      
        self.addPoint(x, y);
      },
      
      mouseupEv(_ev, _, [x, y]) {
        if (self.mode !== "drawing") return;
        // Skip for flood fill mode
        if (self.floodFillEnabled) return;
        
        self.addPoint(x, y);
        self.mode = "viewing";
        brush.setDrawing(false);
        brush.endPath();
        if (isFirstBrushStroke) {
          setTimeout(() => {
            try {
              const newBrush = self.commitDrawingRegion();
              if (newBrush) {
                try {
                  self.obj.annotation.selectArea(newBrush);
                } catch (err) {
                  console.error("Error selecting area:", err);
                }
              }
            } catch (err) {
              console.error("Error committing region:", err);
            }
            self.annotation.history.unfreeze();
            self.obj.annotation.setIsDrawing(false);
          });
        } else {
          self.annotation.history.unfreeze();
          self.obj.annotation.setIsDrawing(false);
        }
      },
    };
  });

const Brush = types.compose(_Tool.name, ToolMixin, BaseTool, DrawingTool, _Tool);

export { Brush };