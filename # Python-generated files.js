# Python-generated files
__pycache__/
*.py[oc]
build/
dist/
wheels/
*.egg-info

# Virtual environments
.venv
from fastapi import APIRouter, HTTPException
from typing import List, Optional
from pydantic import BaseModel
from core.models import Zone, ParkingRequest, ParkingState, Vehicle
from core.logic import ParkingLogic
from core.memory import MemoryStore
from core.analytics import AnalyticsEngine

router = APIRouter()
store = MemoryStore.get_instance()

# --- Request Models ---
class CreateZoneRequest(BaseModel):
    id: str
    name: str
    slot_count: int
    adjacent_ids: List[str]
    area_names: Optional[List[str]] = None

class ParkVehicleRequest(BaseModel):
    vehicle_id: str
    zone_id: str
    area_id: Optional[str] = None

class RollbackRequest(BaseModel):
    k: int

class CreateVehicleRequest(BaseModel):
    vehicle_id: str
    preferred_zone_id: str

# --- Endpoints ---

@router.post("/zones", response_model=Zone)
def create_zone(req: CreateZoneRequest):
    return ParkingLogic.create_zone(req.id, req.name, req.slot_count, req.adjacent_ids, req.area_names)

@router.get("/zones", response_model=List[Zone])
def get_zones():
    return list(store.zones.values())

@router.get("/vehicles", response_model=List[Vehicle])
def get_vehicles():
    return list(store.vehicles.values())

@router.post("/vehicles", response_model=Vehicle)
def create_vehicle(req: CreateVehicleRequest):
    return ParkingLogic.register_vehicle(req.vehicle_id, req.preferred_zone_id)

@router.post("/parking/request", response_model=ParkingRequest)
def request_parking(req: ParkVehicleRequest):
    return ParkingLogic.request_parking(req.vehicle_id, req.zone_id, req.area_id)

@router.get("/parking/requests", response_model=List[ParkingRequest])
def get_requests():
    return list(store.requests.values())

@router.post("/parking/allocate/{request_id}")
def allocate_parking(request_id: str):
    try:
        result = ParkingLogic.allocate_slot(request_id)
        if not result["success"]:
            if result.get("type") == "AREA_FULL":
                raise HTTPException(status_code=409, detail=f"parking is not allowed ,use another level")
            if result.get("type") == "FULL":
                raise HTTPException(status_code=409, detail=f"{result['zone_name']} zone is full. No car register in this zone. Use another zone.")
            raise HTTPException(status_code=409, detail="Allocation failed. Capacity reached.")
        
        return {
            "status": "ALLOCATED", 
            "request_id": request_id, 
            "allocation_type": result["type"],
            "slot_id": result["slot_id"]
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/parking/occupy/{request_id}")
def occupy_parking(request_id: str):
    try:
        ParkingLogic.occupy_slot(request_id)
        return {"status": "OCCUPIED", "request_id": request_id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/parking/release/{identifier}")
def release_parking(identifier: str):
    try:
        ParkingLogic.release_slot(identifier)
        return {"status": "RELEASED", "id": identifier}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/parking/cancel/{request_id}")
def cancel_request(request_id: str):
    try:
        ParkingLogic.cancel_request(request_id)
        return {"status": "CANCELLED", "request_id": request_id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/admin/rollback")
def rollback_operations(req: RollbackRequest):
    ParkingLogic.rollback(req.k)
    return {"status": "ROLLED_BACK", "k": req.k}

@router.get("/admin/analytics")
def get_analytics():
    stats = AnalyticsEngine.get_summary_stats()
    stats["history_stack_size"] = store.history_stack.size()
    return stats
import time
from typing import Dict, List
from core.models import ParkingRequest, ParkingState
from core.memory import MemoryStore

class AnalyticsEngine:
    @staticmethod
    def get_summary_stats() -> Dict:
        store = MemoryStore.get_instance()
        requests = list(store.requests.values())
        
        total_requests = len(requests)
        if total_requests == 0:
            return {
                "total_requests": 0,
                "completed_requests": 0,
                "cancelled_requests": 0,
                "avg_duration": 0,
                "zone_utilization": {}
            }

        completed = [r for r in requests if r.state == ParkingState.RELEASED]
        cancelled = [r for r in requests if r.state == ParkingState.CANCELLED]
        
        # Average Parking Duration
        durations = [(r.end_time - r.request_time) for r in completed if r.end_time and r.request_time]
        avg_duration = sum(durations) / len(durations) if durations else 0

        # Zone Utilization
        zone_util = {}
        for zone_id, zone in store.zones.items():
            total_slots = sum(len(area.slots) for area in zone.parking_areas)
            occupied_slots = sum(1 for area in zone.parking_areas for slot in area.slots if not slot.is_available)
            zone_util[zone_id] = (occupied_slots / total_slots * 100) if total_slots > 0 else 0

        # Peak Usage Zones (based on total requests made per zone)
        zone_request_counts = {}
        for r in requests:
            zone_request_counts[r.zone_id] = zone_request_counts.get(r.zone_id, 0) + 1
        
        peak_zone = max(zone_request_counts, key=zone_request_counts.get) if zone_request_counts else None

        return {
            "total_requests": total_requests,
            "completed_requests": len(completed),
            "cancelled_requests": len(cancelled),
            "avg_duration": round(avg_duration, 2),
            "zone_utilization": zone_util,
            "peak_zone": peak_zone
        }
import time
from typing import Optional
from core.models import ParkingRequest, ParkingState, Zone, Slot, Vehicle, ParkingArea
from core.dsa import StateMachine, Stack
from core.memory import MemoryStore

store = MemoryStore.get_instance()

class ParkingLogic:
    
    @staticmethod

    def create_zone(zone_id: str, name: str, slot_count: int, adjacent_ids: list[str], area_names: Optional[list[str]] = None):
        if not area_names:
            area_names = ["Main"]

        areas = []
        slots_per_area = slot_count // len(area_names)
        remaining_slots = slot_count % len(area_names)

        for i, area_name in enumerate(area_names):
            area_id = f"{zone_id}-A{i+1}"
            count = slots_per_area + (1 if i < remaining_slots else 0)
            
            slots = [
                Slot(id=f"{area_id}-S{j+1}", zone_id=zone_id, parking_area_id=area_id) 
                for j in range(count)
            ]
            area = ParkingArea(id=area_id, name=area_name, zone_id=zone_id, slots=slots)
            areas.append(area)
        
        zone = Zone(id=zone_id, name=name, parking_areas=areas, adjacent_zone_ids=adjacent_ids)
        store.zones[zone_id] = zone
        return zone

    @staticmethod
    def register_vehicle(vehicle_id: str, preferred_zone_id: str) -> Vehicle:
        vehicle = Vehicle(id=vehicle_id, preferred_zone_id=preferred_zone_id)
        store.vehicles[vehicle_id] = vehicle
        return vehicle

    @staticmethod
    def request_parking(vehicle_id: str, zone_id: str, area_id: Optional[str] = None) -> ParkingRequest:
        # 1. Manage Vehicle Persistence (Auto-register if new)
        if vehicle_id not in store.vehicles:
            ParkingLogic.register_vehicle(vehicle_id, zone_id)
        else:
            # Update preference if vehicle returns? (Optional, but good for "Preferred zone")
            store.vehicles[vehicle_id].preferred_zone_id = zone_id

        req_id = f"R-{int(time.time()*1000)}"
        request = ParkingRequest(
            id=req_id,
            vehicle_id=vehicle_id,
            zone_id=zone_id,
            request_time=time.time(),
            state=ParkingState.REQUESTED,
            preferred_area_id=area_id
        )
        store.requests[req_id] = request
        store.request_log.append(request)
        return request

    @staticmethod
    def allocate_slot(request_id: str) -> dict:
        request = store.requests.get(request_id)
        if not request:
            raise ValueError("Request not found")

        # Validation
        StateMachine.transition(request.state, ParkingState.ALLOCATED)

        preferred_zone = store.zones.get(request.zone_id)
        if not preferred_zone:
            raise ValueError("Zone not found")

        slot = None
        
        # 1a. Try Selected Area if provided
        if request.preferred_area_id:
            slot = ParkingLogic._find_available_slot(preferred_zone, request.preferred_area_id)
            if not slot:
                # Specific requirement: "when the leval A is full in Alpha zone..."
                preferred_area = None
                for area in preferred_zone.parking_areas:
                    if area.id == request.preferred_area_id:
                        preferred_area = area
                        break
                
                if preferred_area and preferred_area.name in ["Level A", "Level B"] and ("Alpha" in preferred_zone.name or "Beta" in preferred_zone.name):
                    return {"success": False, "type": "AREA_FULL", "area_name": preferred_area.name}

        # 1b. Fallback to any area in Preferred Zone
        if not slot:
            slot = ParkingLogic._find_available_slot(preferred_zone)
        
        allocation_type = "PRIMARY"
        
        # Cross-zone overspill disabled per user request
        if not slot:
            return {"success": False, "type": "FULL", "zone_name": preferred_zone.name}
        
        if slot:
            # ALLOCATE
            slot.is_available = False
            slot.vehicle_id = request.vehicle_id
            request.allocated_slot_id = slot.id
            request.state = ParkingState.ALLOCATED
            
            # Push to History Stack for Rollback
            store.history_stack.push({
                "type": "ALLOCATE",
                "request_id": request.id,
                "slot_id": slot.id
            })
            return {"success": True, "type": allocation_type, "slot_id": slot.id}
        else:
            return {"success": False, "type": "FAILED"}

    @staticmethod
    def _find_available_slot(zone: Zone, area_id: Optional[str] = None) -> Optional[Slot]:
        for area in zone.parking_areas:
            if area_id and area.id != area_id:
                continue
            for slot in area.slots:
                if slot.is_available:
                    return slot
        return None

    @staticmethod
    def _set_slot_availability(zone: Zone, slot_id: str, is_available: bool, vehicle_id: Optional[str]):
        for area in zone.parking_areas:
            for slot in area.slots:
                if slot.id == slot_id:
                    slot.is_available = is_available
                    slot.vehicle_id = vehicle_id
                    return

    @staticmethod
    def cancel_request(identifier: str):
        # 1. Try finding by Request ID
        request = store.requests.get(identifier)
        
        # 2. If not found, try finding the latest request by Vehicle ID
        if not request:
            latest_req = None
            for req in store.requests.values():
                if req.vehicle_id == identifier:
                    if not latest_req or req.request_time > latest_req.request_time:
                        latest_req = req
            request = latest_req
        
        if not request:
            raise ValueError(f"No request history found for '{identifier}'")
            
        # 3. Handle terminal states
        if request.state == ParkingState.RELEASED:
            raise ValueError("Cannot cancel a request that is already released/completed")
        if request.state == ParkingState.CANCELLED:
            raise ValueError("Request is already cancelled")

        # 4. Perform Transition
        prev_state = request.state
        StateMachine.transition(request.state, ParkingState.CANCELLED)
        
        slot_id = request.allocated_slot_id
        if slot_id:
            # Free the slot (works for ALLOCATED or OCCUPIED)
            zone_id = slot_id.split("-")[0]
            zone = store.zones.get(zone_id)
            if zone:
               ParkingLogic._set_slot_availability(zone, slot_id, True, None)
        
        request.state = ParkingState.CANCELLED
        
        # 5. Push to stack
        store.history_stack.push({
            "type": "CANCEL",
            "request_id": request.id,
            "prev_state": prev_state,
            "slot_id": slot_id
        })

    @staticmethod
    def occupy_slot(identifier: str):
        # 1. Find Request (by ID or Vehicle ID)
        request = store.requests.get(identifier)
        if not request:
            latest_active = None
            for req in store.requests.values():
                if req.vehicle_id == identifier and req.state == ParkingState.ALLOCATED:
                    if not latest_active or req.request_time > latest_active.request_time:
                        latest_active = req
            request = latest_active
        
        if not request:
            raise ValueError(f"No active allocation found for '{identifier}' to occupy.")

        # 2. Transition
        StateMachine.transition(request.state, ParkingState.OCCUPIED)
        request.state = ParkingState.OCCUPIED
        
        # 3. Push to stack
        store.history_stack.push({
            "type": "OCCUPY",
            "request_id": request.id
        })

    @staticmethod
    def release_slot(identifier: str):
        # 1. Find Request (by ID or Vehicle ID)
        request = store.requests.get(identifier)
        if not request:
            latest_active = None
            for req in store.requests.values():
                # Allow release from either ALLOCATED or OCCUPIED
                if req.vehicle_id == identifier and req.state in [ParkingState.ALLOCATED, ParkingState.OCCUPIED]:
                    if not latest_active or req.request_time > latest_active.request_time:
                        latest_active = req
            request = latest_active
        
        if not request:
            # Check if it was already released
            for req in store.requests.values():
                if req.vehicle_id == identifier and req.state == ParkingState.RELEASED:
                    raise ValueError(f"Vehicle '{identifier}' is already released.")
            raise ValueError(f"No active allocation/occupancy found for '{identifier}' to release.")

        if request.state not in [ParkingState.ALLOCATED, ParkingState.OCCUPIED]:
             raise ValueError(f"Request state {request.state} cannot be released. Must be ALLOCATED or OCCUPIED.")

        # 2. Free the slot
        slot_id = request.allocated_slot_id
        if slot_id:
            zone_id = slot_id.split("-")[0]
            zone = store.zones.get(zone_id)
            if zone:
                ParkingLogic._set_slot_availability(zone, slot_id, True, None)
        
        # 3. Update Request
        StateMachine.transition(request.state, ParkingState.RELEASED)
        request.state = ParkingState.RELEASED
        request.end_time = time.time()
        
        # 4. Push to stack
        store.history_stack.push({
            "type": "RELEASE",
            "request_id": request.id,
            "slot_id": slot_id
        })

    @staticmethod
    def rollback(k: int):
        """
        Undo last K operations using the Stack.
        """
        count = 0
        while count < k and not store.history_stack.is_empty():
            action = store.history_stack.pop()
            if not action:
                break
                
            req_id = action["request_id"]
            request = store.requests.get(req_id)
            
            if action["type"] == "ALLOCATE":
                # Undo Allocation: Free slot, set state back to REQUESTED
                slot_id = action["slot_id"]
                request.allocated_slot_id = None
                request.state = ParkingState.REQUESTED
                request.penalty_applied = False
                
                # Make slot available again
                if slot_id:
                     zone_id = slot_id.split("-")[0]
                     zone = store.zones.get(zone_id)
                     if zone:
                         ParkingLogic._set_slot_availability(zone, slot_id, True, None)

            elif action["type"] == "CANCEL":
                # Undo Cancel: Restore state and slot (if it was allocated)
                prev_state = action["prev_state"]
                slot_id = action.get("slot_id")
                
                request.state = prev_state
                
                if slot_id and prev_state == ParkingState.ALLOCATED:
                    request.allocated_slot_id = slot_id
                    # Re-occupy slot
                    zone_id = slot_id.split("-")[0]
                    zone = store.zones.get(zone_id)
                    if zone:
                        ParkingLogic._set_slot_availability(zone, slot_id, False, request.vehicle_id)
            
            elif action["type"] == "OCCUPY":
                # Undo Occupy: Set state back to ALLOCATED
                request.state = ParkingState.ALLOCATED

            elif action["type"] == "RELEASE":
                # Undo Release: Restore to OCCUPIED and re-occupy slot
                slot_id = action["slot_id"]
                request.state = ParkingState.OCCUPIED
                request.end_time = None
                
                if slot_id:
                    zone_id = slot_id.split("-")[0]
                    zone = store.zones.get(zone_id)
                    if zone:
                        ParkingLogic._set_slot_availability(zone, slot_id, False, request.vehicle_id)

            count += 1
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ParkSmart AI | Urban Allocation System</title>
    <link rel="stylesheet" href="style.css">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link
        href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400&display=swap"
        rel="stylesheet">
</head>

<body>
    <div class="glass-bg"></div>
    <div class="container">
        <header>
            <div class="brand">
                <div class="logo-icon">P</div>
                <h1>ParkSmart AI</h1>
            </div>
            <div id="analytics-summary" class="analytics-bar">
                <!-- Data from JS -->
            </div>
        </header>

        <main>
            <div class="dashboard-grid">
                <!-- Left Column: Controls & Requests -->
                <div class="dash-col controls-area">
                    <div class="card glass-effect">
                        <div class="card-header">
                            <span class="icon">??</span>
                            <h2>Vehicle Request</h2>
                        </div>
                        <form id="request-form">
                            <div class="input-group">
                                <label for="vehicle-id">Vehicle ID</label>
                                <input type="text" id="vehicle-id" placeholder="e.g. ABC-123" required>
                            </div>
                            <div class="input-group">
                                <label for="zone-select">Preferred Zone</label>
                                <select id="zone-select" required>
                                    <option value="" disabled selected>Select Zone</option>
                                </select>
                            </div>
                            <div class="input-group">
                                <label for="area-select">Preferred Area (Optional)</label>
                                <select id="area-select">
                                    <option value="" selected>Any Area</option>
                                </select>
                            </div>
                            <button type="submit" class="btn btn-primary">Request Allocation</button>
                        </form>
                    </div>

                    <div class="card glass-effect">
                        <div class="card-header">
                            <span class="icon">??</span>
                            <h2>Admin Control</h2>
                        </div>
                        <div class="admin-actions">
                            <div class="action-row">
                                <input type="text" id="action-id" placeholder="Request/Vehicle ID">
                                <div class="action-buttons">
                                    <button id="occupy-btn" class="btn btn-info">Occupy</button>
                                    <button id="release-btn" class="btn btn-success">Release</button>
                                    <button id="cancel-btn" class="btn btn-danger">Cancel</button>
                                </div>
                            </div>
                            <div class="action-divider"></div>
                            <div class="rollback-row">
                                <input type="number" id="rollback-k" placeholder="K" value="1" min="1">
                                <button id="rollback-btn" class="btn btn-warning">Rollback Operations</button>
                            </div>
                        </div>
                    </div>

                    <div class="card glass-effect">
                        <div class="card-header">
                            <span class="icon">??</span>
                            <h2>Active Lifecycle</h2>
                        </div>
                        <div class="request-list-container">
                            <ul id="request-list" class="styled-list">
                                <!-- Requests populated by JS -->
                            </ul>
                        </div>
                    </div>
                </div>

                <!-- Right Column: Monitor & Analytics -->
                <div class="dash-col monitor-area">
                    <div class="card glass-effect monitor-card">
                        <div class="card-header">
                            <span class="icon">??</span>
                            <h2>Live Zone Monitor</h2>
                        </div>
                        <div id="zones-container" class="zones-grid">
                            <!-- Zones and Slots rendered here -->
                        </div>
                    </div>

                    <div class="analytics-grid">
                        <div class="card glass-effect stat-card">
                            <h3>Analytics Insight</h3>
                            <div id="analytics-details" class="stats-content">
                                <!-- Detailed analytics -->
                            </div>
                        </div>
                        <div class="card glass-effect logs-card">
                            <h3>System Logs</h3>
                            <div id="log-container" class="terminal-logs"></div>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    </div>
    <script src="script.js"></script>
</body>

</html>
const API_URL = "/api";
let currentZones = [];

// Initialize Dashboard
async function init() {
    const zones = await fetchZones();
    if (zones.length === 0) {
        await setupSimulationZones();
    }
    await refreshDashboard();

    // Efficient Polling using recursive setTimeout
    async function poll() {
        await refreshDashboard();
        setTimeout(poll, 3000);
    }
    setTimeout(poll, 3000);
}

async function fetchZones() {
    try {
        const res = await fetch(`${API_URL}/zones`);
        return await res.json();
    } catch { return []; }
}

async function setupSimulationZones() {
    const zonesToCreate = [
        { id: "Z1", name: "Alpha Premium", slot_count: 6, adjacent_ids: ["Z2"], area_names: ["Level A", "Level B"] },
        { id: "Z2", name: "Beta District", slot_count: 8, adjacent_ids: ["Z1", "Z3"], area_names: ["Level A", "Level B"] },
        { id: "Z3", name: "Gamma sector", slot_count: 12, adjacent_ids: ["Z2"], area_names: ["Underground"] }
    ];

    for (const z of zonesToCreate) {
        await fetch(`${API_URL}/zones`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(z)
        });
    }
}

async function refreshDashboard() {
    const [zones, analytics, requests] = await Promise.all([
        fetchZones(),
        fetch(`${API_URL}/admin/analytics`).then(r => r.json()),
        fetch(`${API_URL}/parking/requests`).then(r => r.json())
    ]);

    renderZones(zones);
    renderAnalytics(analytics);
    renderRequests(requests);
    populateZoneSelect(zones);
    currentZones = zones; // Store for area selection
}

function populateZoneSelect(zones) {
    const select = document.getElementById("zone-select");
    if (select.children.length <= 1) {
        zones.forEach(z => {
            const opt = document.createElement("option");
            opt.value = z.id;
            opt.textContent = z.name;
            select.appendChild(opt);
        });
    }
}

function updateAreaSelect(zoneId) {
    const areaSelect = document.getElementById("area-select");
    areaSelect.innerHTML = '<option value="" selected>Any Area</option>';

    if (!zoneId) return;

    const zone = currentZones.find(z => z.id === zoneId);
    if (zone) {
        zone.parking_areas.forEach(area => {
            const opt = document.createElement("option");
            opt.value = area.id;
            opt.textContent = area.name;
            areaSelect.appendChild(opt);
        });
    }
}

document.getElementById("zone-select").addEventListener("change", (e) => {
    updateAreaSelect(e.target.value);
});

function renderRequests(requests) {
    const list = document.getElementById("request-list");
    list.innerHTML = "";
    requests.sort((a, b) => b.request_time - a.request_time);

    requests.slice(0, 15).forEach(r => {
        const li = document.createElement("li");
        li.className = "list-item";

        const stateClass = `badge-${r.state.toLowerCase()}`;
        const timeStr = new Date(r.request_time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        li.innerHTML = `
            <div class="item-info">
                <span class="item-id">${r.vehicle_id}</span>
                <span class="item-sub">${r.zone_id} • ${timeStr} ${r.penalty_applied ? '?? Overspill' : ''}</span>
            </div>
            <div class="item-status">
                <span class="badge ${stateClass}">${r.state}</span>
            </div>
        `;
        list.appendChild(li);
    });
}

function renderZones(zones) {
    const container = document.getElementById("zones-container");
    container.innerHTML = "";

    zones.forEach(zone => {
        const total = zone.parking_areas.reduce((acc, area) => acc + area.slots.length, 0);
        const occupiedCount = zone.parking_areas.reduce((acc, area) => acc + area.slots.filter(s => !s.is_available).length, 0);
        const utilPercent = (occupiedCount / total) * 100;

        const zoneDiv = document.createElement("div");
        zoneDiv.className = "zone-container";

        let areasHtml = "";
        zone.parking_areas.forEach(area => {
            let slotsHtml = "";
            area.slots.forEach(slot => {
                const statusClass = slot.is_available ? "available" : "occupied";
                const label = slot.is_available ? slot.id.split('-S')[1] : '•';
                slotsHtml += `<div class="slot-node ${statusClass}" title="${slot.id} - ${slot.vehicle_id || 'Available'}">${label}</div>`;
            });
            areasHtml += `
                <div class="area-group">
                    <div class="area-subtitle">${area.name}</div>
                    <div class="slots-wrapper">${slotsHtml}</div>
                </div>
            `;
        });

        const statusLabel = occupiedCount >= total ? '<span class="badge badge-cancelled">FULL</span>' : '<span class="badge badge-allocated">AVAILABLE</span>';

        zoneDiv.innerHTML = `
            <div class="zone-title">
                <span>${zone.name} ${statusLabel}</span>
                <span class="item-sub">${occupiedCount}/${total}</span>
            </div>
            <div class="util-bar">
                <div class="util-fill" style="width: ${utilPercent}%"></div>
            </div>
            ${areasHtml}
        `;
        container.appendChild(zoneDiv);
    });
}

function renderAnalytics(data) {
    const summary = document.getElementById("analytics-summary");
    summary.innerHTML = `
        <div class="stat-chip"><span class="label">Total</span><span class="value">${data.total_requests}</span></div>
        <div class="stat-chip"><span class="label">Stack</span><span class="value">${data.history_stack_size}</span></div>
        <div class="stat-chip"><span class="label">Peak</span><span class="value">${data.peak_zone || 'N/A'}</span></div>
    `;

    const details = document.getElementById("analytics-details");
    details.innerHTML = `
        <div class="mini-stat"><span class="m-label">Avg Duration</span><span class="m-value">${data.avg_duration}s</span></div>
        <div class="mini-stat"><span class="m-label">Completed</span><span class="m-value">${data.completed_requests}</span></div>
        <div class="mini-stat"><span class="m-label">Cancelled</span><span class="m-value">${data.cancelled_requests}</span></div>
        <div class="mini-stat"><span class="m-label">Success Rate</span><span class="m-value">${data.total_requests > 0 ? Math.round((data.completed_requests / data.total_requests) * 100) : 0}%</span></div>
    `;
}

function log(msg, type = 'info') {
    const container = document.getElementById("log-container");
    const line = document.createElement("div");
    line.className = "log-line";
    const color = type === 'error' ? '#ef4444' : (type === 'success' ? '#10b981' : '#4ade80');
    line.innerHTML = `<span style="color: #64748b">[${new Date().toLocaleTimeString()}]</span> <span style="color: ${color}">${msg}</span>`;
    container.prepend(line);
}

// Event Listeners
document.getElementById("request-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const vehicleId = document.getElementById("vehicle-id").value;
    const zoneId = document.getElementById("zone-select").value;
    const areaId = document.getElementById("area-select").value;

    try {
        const reqRes = await fetch(`${API_URL}/parking/request`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                vehicle_id: vehicleId,
                zone_id: zoneId,
                area_id: areaId || null
            })
        });
        const reqData = await reqRes.json();

        const allocRes = await fetch(`${API_URL}/parking/allocate/${reqData.id}`, { method: "POST" });
        if (allocRes.ok) {
            const allocData = await allocRes.json();
            if (allocData.allocation_type === "CROSS_ZONE") {
                log(`ZONE FULL: ${zoneId} is saturated. Redirected!`, 'warning');
            } else {
                log(`ALLOCATED: ${vehicleId} ? ${zoneId}`, 'success');
            }
            document.getElementById("action-id").value = vehicleId;
        } else {
            const err = await allocRes.json();
            log(`DENIED: ${err.detail}`, 'error');
        }
    } catch (err) { log(`SYSTEM ERROR`, 'error'); }
    refreshDashboard();
});

async function runAction(action, endpoint) {
    const id = document.getElementById("action-id").value;
    if (!id) return log("Enter ID first", "error");

    try {
        const res = await fetch(`${API_URL}/parking/${endpoint}/${id}`, { method: "POST" });
        if (res.ok) {
            log(`${action.toUpperCase()} confirmed for ${id}`, 'success');
        } else {
            const err = await res.json();
            log(`${action} failed: ${err.detail}`, 'error');
        }
    } catch { log(`Network Error`, 'error'); }
    refreshDashboard();
}

document.getElementById("occupy-btn").addEventListener("click", () => runAction('Occupy', 'occupy'));
document.getElementById("release-btn").addEventListener("click", () => runAction('Release', 'release'));
document.getElementById("cancel-btn").addEventListener("click", () => runAction('Cancel', 'cancel'));

document.getElementById("rollback-btn").addEventListener("click", async () => {
    const k = document.getElementById("rollback-k").value;
    try {
        const res = await fetch(`${API_URL}/admin/rollback`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ k: parseInt(k) })
        });
        if (res.ok) log(`ROLLBACK: Reverted last ${k} ops`, 'warning');
    } catch { log("Rollback failed", "error"); }
    refreshDashboard();
});

init();
:root {
    --bg-dark: #080a0f;
    --bg-surface: #11141d;
    --accent-primary: #6366f1;
    --accent-secondary: #a855f7;
    --accent-success: #10b981;
    --accent-error: #ef4444;
    --accent-info: #0ea5e9;
    --accent-warning: #f59e0b;
    --text-high: #f8fafc;
    --text-mid: #94a3b8;
    --text-low: #475569;
    --glass-bg: rgba(17, 20, 29, 0.7);
    --glass-border: rgba(255, 255, 255, 0.08);
    --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.3), 0 8px 10px -6px rgb(0 0 0 / 0.3);
}

* {
    box-sizing: border-box;
    scrollbar-width: thin;
    scrollbar-color: var(--accent-primary) transparent;
}

body {
    margin: 0;
    font-family: 'Outfit', sans-serif;
    background-color: var(--bg-dark);
    color: var(--text-high);
    min-height: 100vh;
    overflow-x: hidden;
}

.glass-bg {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: -1;
    background: radial-gradient(circle at 0% 0%, rgba(99, 102, 241, 0.15) 0%, transparent 40%),
        radial-gradient(circle at 100% 100%, rgba(168, 85, 247, 0.1) 0%, transparent 40%);
}

.container {
    max-width: 1500px;
    margin: 0 auto;
    padding: 1.5rem;
}

/* Header */
header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 0;
    margin-bottom: 2rem;
}

.brand {
    display: flex;
    align-items: center;
    gap: 1rem;
}

.logo-icon {
    width: 40px;
    height: 40px;
    background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    font-size: 1.5rem;
    box-shadow: 0 0 20px rgba(99, 102, 241, 0.4);
}

h1 {
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: 0;
}

.analytics-bar {
    display: flex;
    gap: 1.5rem;
}

.stat-chip {
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    backdrop-filter: blur(10px);
    padding: 0.5rem 1rem;
    border-radius: 30px;
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.stat-chip .label {
    color: var(--text-mid);
}

.stat-chip .value {
    font-weight: 600;
    color: var(--accent-primary);
}

/* Dashboard Grid */
.dashboard-grid {
    display: grid;
    grid-template-columns: 420px 1fr;
    gap: 1.5rem;
}

.dash-col {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
}

/* Cards */
.card {
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    backdrop-filter: blur(12px);
    border-radius: 20px;
    padding: 1.5rem;
    box-shadow: var(--shadow-xl);
}

.card-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
}

.card-header h2 {
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-mid);
}

/* Forms & Inputs */
.input-group {
    margin-bottom: 1.25rem;
}

.input-group label {
    display: block;
    font-size: 0.75rem;
    color: var(--text-mid);
    margin-bottom: 0.5rem;
    font-weight: 500;
}

input,
select {
    width: 100%;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    padding: 0.75rem 1rem;
    color: var(--text-high);
    font-family: inherit;
    font-size: 0.9rem;
    transition: all 0.2s;
}

input:focus,
select:focus {
    outline: none;
    border-color: var(--accent-primary);
    background: rgba(255, 255, 255, 0.06);
    box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
}

/* Buttons */
.btn {
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-radius: 12px;
    font-weight: 600;
    font-size: 0.9rem;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
}

.btn:hover {
    transform: translateY(-2px);
    filter: brightness(1.1);
}

.btn:active {
    transform: translateY(0);
}

.btn-primary {
    background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
    color: white;
    box-shadow: 0 8px 15px rgba(99, 102, 241, 0.2);
}

.btn-info {
    background: rgba(14, 165, 233, 0.15);
    color: var(--accent-info);
    border: 1px solid rgba(14, 165, 233, 0.3);
}

.btn-success {
    background: rgba(16, 185, 129, 0.15);
    color: var(--accent-success);
    border: 1px solid rgba(16, 185, 129, 0.3);
}

.btn-danger {
    background: rgba(239, 68, 68, 0.15);
    color: var(--accent-error);
    border: 1px solid rgba(239, 68, 68, 0.3);
}

.btn-warning {
    background: rgba(245, 158, 11, 0.15);
    color: var(--accent-warning);
    border: 1px solid rgba(245, 158, 11, 0.3);
}

/* Admin Grid */
.admin-actions {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
}

.action-row {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.action-buttons {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
}

.action-divider {
    height: 1px;
    background: var(--glass-border);
    margin: 0.5rem 0;
}

.rollback-row {
    display: grid;
    grid-template-columns: 80px 1fr;
    gap: 0.75rem;
}

/* Lists */
.request-list-container {
    max-height: 400px;
    overflow-y: auto;
    padding-right: 0.5rem;
}

.styled-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.list-item {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    padding: 1rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    transition: background 0.2s;
}

.list-item:hover {
    background: rgba(255, 255, 255, 0.04);
}

.item-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
}

.item-id {
    font-weight: 600;
    font-size: 0.9rem;
}

.item-sub {
    font-size: 0.75rem;
    color: var(--text-mid);
}

/* Status Badges */
.badge {
    padding: 0.25rem 0.6rem;
    border-radius: 6px;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
}

.badge-requested {
    background: rgba(148, 163, 184, 0.15);
    color: #94a3b8;
}

.badge-allocated {
    background: rgba(14, 165, 233, 0.15);
    color: #0ea5e9;
}

.badge-occupied {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
}

.badge-released {
    background: rgba(16, 185, 129, 0.15);
    color: #10b981;
}

/* Monitor Area */
.monitor-card {
    flex: 1;
}

.zones-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1.25rem;
}

.zone-container {
    background: rgba(255, 255, 255, 0.03);
    border-radius: 16px;
    padding: 1.25rem;
    border: 1px solid var(--glass-border);
}

.zone-title {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    font-weight: 600;
    font-size: 0.95rem;
}

.util-bar {
    height: 4px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 2px;
    flex: 1;
    margin: 0 1rem;
    overflow: hidden;
}

.util-fill {
    height: 100%;
    background: var(--accent-primary);
    transition: width 0.5s ease;
}

.area-group {
    margin-top: 1rem;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--glass-border);
}

.area-subtitle {
    font-size: 0.75rem;
    color: var(--text-mid);
    margin-bottom: 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.slots-wrapper {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(45px, 1fr));
    gap: 0.5rem;
}

.slot-node {
    aspect-ratio: 1;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.65rem;
    font-weight: 700;
    cursor: default;
    transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.slot-node.available {
    background: rgba(16, 185, 129, 0.05);
    border: 1px solid rgba(16, 185, 129, 0.2);
    color: var(--accent-success);
}

.slot-node.occupied {
    background: rgba(239, 68, 68, 0.2);
    border: 1px solid rgba(239, 68, 68, 0.4);
    color: var(--accent-error);
    box-shadow: 0 0 15px rgba(239, 68, 68, 0.15);
}

/* Analytics & Logs Bottom */
.analytics-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1.5rem;
}

.stat-card .stats-content {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
}

.mini-stat {
    background: rgba(0, 0, 0, 0.2);
    padding: 0.75rem;
    border-radius: 12px;
}

.mini-stat .m-label {
    font-size: 0.7rem;
    color: var(--text-mid);
    display: block;
    margin-bottom: 0.25rem;
}

.mini-stat .m-value {
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--text-high);
}

.terminal-logs {
    height: 150px;
    background: #000;
    border-radius: 12px;
    padding: 1rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    overflow-y: auto;
    color: #4ade80;
}

.log-line {
    margin-bottom: 0.4rem;
    opacity: 0.8;
}

/* Animations */
@keyframes slideIn {
    from {
        opacity: 0;
        transform: translateY(10px);
    }

    to {
        opacity: 1;
        transform: translateY(0);
    }
}

.list-item {
    animation: slideIn 0.3s ease-out forwards;
}

/* Responsive */
@media (max-width: 1100px) {
    .dashboard-grid {
        grid-template-columns: 1fr;
    }
}
import sys
import os
import unittest

# Add project root to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from core.dsa import Stack, StateMachine
from core.models import ParkingState
from core.logic import ParkingLogic, store

class TestSmartParking(unittest.TestCase):
    
    def setUp(self):
        store.reset()
        # Setup Zones
        ParkingLogic.create_zone("Z1", "Premium", 2, ["Z2"])
        ParkingLogic.create_zone("Z2", "Standard", 2, ["Z1"])

    def test_vehicle_persistence(self):
        """0. Test Vehicle Persistence"""
        ParkingLogic.request_parking("V_TEST", "Z1")
        self.assertIn("V_TEST", store.vehicles)
        self.assertEqual(store.vehicles["V_TEST"].preferred_zone_id, "Z1")

    def test_stack_operations(self):
        """1. Test Stack Push/Pop"""
        s = Stack()
        s.push(1)
        s.push(2)
        self.assertEqual(s.pop(), 2)
        self.assertEqual(s.pop(), 1)
        self.assertIsNone(s.pop())

    def test_state_machine_valid(self):
        """2. Test Valid Transitions"""
        self.assertTrue(StateMachine.validate_transition(ParkingState.REQUESTED, ParkingState.ALLOCATED))
        
    def test_state_machine_invalid(self):
        """3. Test Invalid Transitions"""
        self.assertFalse(StateMachine.validate_transition(ParkingState.REQUESTED, ParkingState.RELEASED))
        with self.assertRaises(ValueError):
            StateMachine.transition(ParkingState.REQUESTED, ParkingState.RELEASED)

    def test_allocation_success(self):
        """4. Test Successful Allocation"""
        req = ParkingLogic.request_parking("V1", "Z1")
        success = ParkingLogic.allocate_slot(req.id)
        self.assertTrue(success)
        self.assertEqual(req.state, ParkingState.ALLOCATED)
        self.assertIsNotNone(req.allocated_slot_id)

    def test_allocation_full_failure(self):
        """5. Test Allocation when full (no adjacent available)"""
        # Fill Z1
        req1 = ParkingLogic.request_parking("V1", "Z1")
        ParkingLogic.allocate_slot(req1.id)
        req2 = ParkingLogic.request_parking("V2", "Z1")
        ParkingLogic.allocate_slot(req2.id)
        
        # Fill Z2 (Adjacent)
        req3 = ParkingLogic.request_parking("V3", "Z2")
        ParkingLogic.allocate_slot(req3.id)
        req4 = ParkingLogic.request_parking("V4", "Z2")
        ParkingLogic.allocate_slot(req4.id)

        # Try to park in Z1 (Should fail as Z1 and Z2 are full)
        req5 = ParkingLogic.request_parking("V5", "Z1")
        success = ParkingLogic.allocate_slot(req5.id)
        self.assertFalse(success)

    def test_cross_zone_allocation(self):
        """6. Test Cross-Zone Allocation with Penalty"""
        # Fill Z1
        req1 = ParkingLogic.request_parking("V1", "Z1")
        ParkingLogic.allocate_slot(req1.id)
        req2 = ParkingLogic.request_parking("V2", "Z1")
        ParkingLogic.allocate_slot(req2.id)

        # Request for Z1, should go to Z2
        req3 = ParkingLogic.request_parking("V3", "Z1")
        success = ParkingLogic.allocate_slot(req3.id)
        self.assertTrue(success)
        self.assertTrue(req3.allocated_slot_id.startswith("Z2"))
        self.assertTrue(req3.penalty_applied)

    def test_cancellation(self):
        """7. Test Cancellation"""
        req = ParkingLogic.request_parking("V1", "Z1")
        ParkingLogic.allocate_slot(req.id)
        ParkingLogic.cancel_request(req.id)
        
        self.assertEqual(req.state, ParkingState.CANCELLED)
        # Verify slot is free
        zone = store.zones["Z1"]
        slot = zone.parking_areas[0].slots[0]
        self.assertTrue(slot.is_available)

    def test_rollback_allocation(self):
        """8. Test Rollback of Allocation"""
        req = ParkingLogic.request_parking("V1", "Z1")
        ParkingLogic.allocate_slot(req.id)
        
        ParkingLogic.rollback(1)
        self.assertEqual(req.state, ParkingState.REQUESTED)
        self.assertIsNone(req.allocated_slot_id)
        # Slot should be free
        self.assertTrue(store.zones["Z1"].parking_areas[0].slots[0].is_available)

    def test_rollback_cancellation(self):
        """9. Test Rollback of Cancellation"""
        req = ParkingLogic.request_parking("V1", "Z1")
        ParkingLogic.allocate_slot(req.id)
        ParkingLogic.cancel_request(req.id)
        
        ParkingLogic.rollback(1)
        self.assertEqual(req.state, ParkingState.ALLOCATED)
        self.assertIsNotNone(req.allocated_slot_id)
        # Slot should be occupied
        self.assertFalse(store.zones["Z1"].parking_areas[0].slots[0].is_available)

    def test_analytics_correctness(self):
        """10. Test Analytics before and after rollback"""
        store.reset()
        # Re-create Zone for this isolated test
        ParkingLogic.create_zone("Z1", "Premium", 2, ["Z2"])
        
        req1 = ParkingLogic.request_parking("V1", "Z1") # 1 Request
        
        self.assertEqual(len(store.request_log), 1)
        
        ParkingLogic.allocate_slot(req1.id)
        ParkingLogic.rollback(1)
        
        # Requests log should still show 1 request, but state is back to REQUESTED
        self.assertEqual(len(store.request_log), 1)
        self.assertEqual(store.request_log[0].state, ParkingState.REQUESTED)

if __name__ == '__main__':
    unittest.main()
version = 1
revision = 3
requires-python = ">=3.14"

[[package]]
name = "annotated-doc"
version = "0.0.4"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/57/ba/046ceea27344560984e26a590f90bc7f4a75b06701f653222458922b558c/annotated_doc-0.0.4.tar.gz", hash = "sha256:fbcda96e87e9c92ad167c2e53839e57503ecfda18804ea28102353485033faa4", size = 7288, upload-time = "2025-11-10T22:07:42.062Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/1e/d3/26bf1008eb3d2daa8ef4cacc7f3bfdc11818d111f7e2d0201bc6e3b49d45/annotated_doc-0.0.4-py3-none-any.whl", hash = "sha256:571ac1dc6991c450b25a9c2d84a3705e2ae7a53467b5d111c24fa8baabbed320", size = 5303, upload-time = "2025-11-10T22:07:40.673Z" },
]

[[package]]
name = "annotated-types"
version = "0.7.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/ee/67/531ea369ba64dcff5ec9c3402f9f51bf748cec26dde048a2f973a4eea7f5/annotated_types-0.7.0.tar.gz", hash = "sha256:aff07c09a53a08bc8cfccb9c85b05f1aa9a2a6f23728d790723543408344ce89", size = 16081, upload-time = "2024-05-20T21:33:25.928Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/78/b6/6307fbef88d9b5ee7421e68d78a9f162e0da4900bc5f5793f6d3d0e34fb8/annotated_types-0.7.0-py3-none-any.whl", hash = "sha256:1f02e8b43a8fbbc3f3e0d4f0f4bfc8131bcb4eebe8849b8e5c773f3a1c582a53", size = 13643, upload-time = "2024-05-20T21:33:24.1Z" },
]

[[package]]
name = "anyio"
version = "4.12.1"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "idna" },
]
sdist = { url = "https://files.pythonhosted.org/packages/96/f0/5eb65b2bb0d09ac6776f2eb54adee6abe8228ea05b20a5ad0e4945de8aac/anyio-4.12.1.tar.gz", hash = "sha256:41cfcc3a4c85d3f05c932da7c26d0201ac36f72abd4435ba90d0464a3ffed703", size = 228685, upload-time = "2026-01-06T11:45:21.246Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/38/0e/27be9fdef66e72d64c0cdc3cc2823101b80585f8119b5c112c2e8f5f7dab/anyio-4.12.1-py3-none-any.whl", hash = "sha256:d405828884fc140aa80a3c667b8beed277f1dfedec42ba031bd6ac3db606ab6c", size = 113592, upload-time = "2026-01-06T11:45:19.497Z" },
]

[[package]]
name = "click"
version = "8.3.1"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "colorama", marker = "sys_platform == 'win32'" },
]
sdist = { url = "https://files.pythonhosted.org/packages/3d/fa/656b739db8587d7b5dfa22e22ed02566950fbfbcdc20311993483657a5c0/click-8.3.1.tar.gz", hash = "sha256:12ff4785d337a1bb490bb7e9c2b1ee5da3112e94a8622f26a6c77f5d2fc6842a", size = 295065, upload-time = "2025-11-15T20:45:42.706Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/98/78/01c019cdb5d6498122777c1a43056ebb3ebfeef2076d9d026bfe15583b2b/click-8.3.1-py3-none-any.whl", hash = "sha256:981153a64e25f12d547d3426c367a4857371575ee7ad18df2a6183ab0545b2a6", size = 108274, upload-time = "2025-11-15T20:45:41.139Z" },
]

[[package]]
name = "colorama"
version = "0.4.6"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/d8/53/6f443c9a4a8358a93a6792e2acffb9d9d5cb0a5cfd8802644b7b1c9a02e4/colorama-0.4.6.tar.gz", hash = "sha256:08695f5cb7ed6e0531a20572697297273c47b8cae5a63ffc6d6ed5c201be6e44", size = 27697, upload-time = "2022-10-25T02:36:22.414Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/d1/d6/3965ed04c63042e047cb6a3e6ed1a63a35087b6a609aa3a15ed8ac56c221/colorama-0.4.6-py2.py3-none-any.whl", hash = "sha256:4f1d9991f5acc0ca119f9d443620b77f9d6b33703e51011c16baf57afb285fc6", size = 25335, upload-time = "2022-10-25T02:36:20.889Z" },
]

[[package]]
name = "fastapi"
version = "0.128.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "annotated-doc" },
    { name = "pydantic" },
    { name = "starlette" },
    { name = "typing-extensions" },
]
sdist = { url = "https://files.pythonhosted.org/packages/52/08/8c8508db6c7b9aae8f7175046af41baad690771c9bcde676419965e338c7/fastapi-0.128.0.tar.gz", hash = "sha256:1cc179e1cef10a6be60ffe429f79b829dce99d8de32d7acb7e6c8dfdf7f2645a", size = 365682, upload-time = "2025-12-27T15:21:13.714Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/5c/05/5cbb59154b093548acd0f4c7c474a118eda06da25aa75c616b72d8fcd92a/fastapi-0.128.0-py3-none-any.whl", hash = "sha256:aebd93f9716ee3b4f4fcfe13ffb7cf308d99c9f3ab5622d8877441072561582d", size = 103094, upload-time = "2025-12-27T15:21:12.154Z" },
]

[[package]]
name = "h11"
version = "0.16.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/01/ee/02a2c011bdab74c6fb3c75474d40b3052059d95df7e73351460c8588d963/h11-0.16.0.tar.gz", hash = "sha256:4e35b956cf45792e4caa5885e69fba00bdbc6ffafbfa020300e549b208ee5ff1", size = 101250, upload-time = "2025-04-24T03:35:25.427Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/04/4b/29cac41a4d98d144bf5f6d33995617b185d14b22401f75ca86f384e87ff1/h11-0.16.0-py3-none-any.whl", hash = "sha256:63cf8bbe7522de3bf65932fda1d9c2772064ffb3dae62d55932da54b31cb6c86", size = 37515, upload-time = "2025-04-24T03:35:24.344Z" },
]

[[package]]
name = "idna"
version = "3.11"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/6f/6d/0703ccc57f3a7233505399edb88de3cbd678da106337b9fcde432b65ed60/idna-3.11.tar.gz", hash = "sha256:795dafcc9c04ed0c1fb032c2aa73654d8e8c5023a7df64a53f39190ada629902", size = 194582, upload-time = "2025-10-12T14:55:20.501Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/0e/61/66938bbb5fc52dbdf84594873d5b51fb1f7c7794e9c0f5bd885f30bc507b/idna-3.11-py3-none-any.whl", hash = "sha256:771a87f49d9defaf64091e6e6fe9c18d4833f140bd19464795bc32d966ca37ea", size = 71008, upload-time = "2025-10-12T14:55:18.883Z" },
]

[[package]]
name = "pydantic"
version = "2.12.5"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "annotated-types" },
    { name = "pydantic-core" },
    { name = "typing-extensions" },
    { name = "typing-inspection" },
]
sdist = { url = "https://files.pythonhosted.org/packages/69/44/36f1a6e523abc58ae5f928898e4aca2e0ea509b5aa6f6f392a5d882be928/pydantic-2.12.5.tar.gz", hash = "sha256:4d351024c75c0f085a9febbb665ce8c0c6ec5d30e903bdb6394b7ede26aebb49", size = 821591, upload-time = "2025-11-26T15:11:46.471Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/5a/87/b70ad306ebb6f9b585f114d0ac2137d792b48be34d732d60e597c2f8465a/pydantic-2.12.5-py3-none-any.whl", hash = "sha256:e561593fccf61e8a20fc46dfc2dfe075b8be7d0188df33f221ad1f0139180f9d", size = 463580, upload-time = "2025-11-26T15:11:44.605Z" },
]

[[package]]
name = "pydantic-core"
version = "2.41.5"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "typing-extensions" },
]
sdist = { url = "https://files.pythonhosted.org/packages/71/70/23b021c950c2addd24ec408e9ab05d59b035b39d97cdc1130e1bce647bb6/pydantic_core-2.41.5.tar.gz", hash = "sha256:08daa51ea16ad373ffd5e7606252cc32f07bc72b28284b6bc9c6df804816476e", size = 460952, upload-time = "2025-11-04T13:43:49.098Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/ea/28/46b7c5c9635ae96ea0fbb779e271a38129df2550f763937659ee6c5dbc65/pydantic_core-2.41.5-cp314-cp314-macosx_10_12_x86_64.whl", hash = "sha256:3f37a19d7ebcdd20b96485056ba9e8b304e27d9904d233d7b1015db320e51f0a", size = 2119622, upload-time = "2025-11-04T13:40:56.68Z" },
    { url = "https://files.pythonhosted.org/packages/74/1a/145646e5687e8d9a1e8d09acb278c8535ebe9e972e1f162ed338a622f193/pydantic_core-2.41.5-cp314-cp314-macosx_11_0_arm64.whl", hash = "sha256:1d1d9764366c73f996edd17abb6d9d7649a7eb690006ab6adbda117717099b14", size = 1891725, upload-time = "2025-11-04T13:40:58.807Z" },
    { url = "https://files.pythonhosted.org/packages/23/04/e89c29e267b8060b40dca97bfc64a19b2a3cf99018167ea1677d96368273/pydantic_core-2.41.5-cp314-cp314-manylinux_2_17_aarch64.manylinux2014_aarch64.whl", hash = "sha256:25e1c2af0fce638d5f1988b686f3b3ea8cd7de5f244ca147c777769e798a9cd1", size = 1915040, upload-time = "2025-11-04T13:41:00.853Z" },
    { url = "https://files.pythonhosted.org/packages/84/a3/15a82ac7bd97992a82257f777b3583d3e84bdb06ba6858f745daa2ec8a85/pydantic_core-2.41.5-cp314-cp314-manylinux_2_17_armv7l.manylinux2014_armv7l.whl", hash = "sha256:506d766a8727beef16b7adaeb8ee6217c64fc813646b424d0804d67c16eddb66", size = 2063691, upload-time = "2025-11-04T13:41:03.504Z" },
    { url = "https://files.pythonhosted.org/packages/74/9b/0046701313c6ef08c0c1cf0e028c67c770a4e1275ca73131563c5f2a310a/pydantic_core-2.41.5-cp314-cp314-manylinux_2_17_ppc64le.manylinux2014_ppc64le.whl", hash = "sha256:4819fa52133c9aa3c387b3328f25c1facc356491e6135b459f1de698ff64d869", size = 2213897, upload-time = "2025-11-04T13:41:05.804Z" },
    { url = "https://files.pythonhosted.org/packages/8a/cd/6bac76ecd1b27e75a95ca3a9a559c643b3afcd2dd62086d4b7a32a18b169/pydantic_core-2.41.5-cp314-cp314-manylinux_2_17_s390x.manylinux2014_s390x.whl", hash = "sha256:2b761d210c9ea91feda40d25b4efe82a1707da2ef62901466a42492c028553a2", size = 2333302, upload-time = "2025-11-04T13:41:07.809Z" },
    { url = "https://files.pythonhosted.org/packages/4c/d2/ef2074dc020dd6e109611a8be4449b98cd25e1b9b8a303c2f0fca2f2bcf7/pydantic_core-2.41.5-cp314-cp314-manylinux_2_17_x86_64.manylinux2014_x86_64.whl", hash = "sha256:22f0fb8c1c583a3b6f24df2470833b40207e907b90c928cc8d3594b76f874375", size = 2064877, upload-time = "2025-11-04T13:41:09.827Z" },
    { url = "https://files.pythonhosted.org/packages/18/66/e9db17a9a763d72f03de903883c057b2592c09509ccfe468187f2a2eef29/pydantic_core-2.41.5-cp314-cp314-manylinux_2_5_i686.manylinux1_i686.whl", hash = "sha256:2782c870e99878c634505236d81e5443092fba820f0373997ff75f90f68cd553", size = 2180680, upload-time = "2025-11-04T13:41:12.379Z" },
    { url = "https://files.pythonhosted.org/packages/d3/9e/3ce66cebb929f3ced22be85d4c2399b8e85b622db77dad36b73c5387f8f8/pydantic_core-2.41.5-cp314-cp314-musllinux_1_1_aarch64.whl", hash = "sha256:0177272f88ab8312479336e1d777f6b124537d47f2123f89cb37e0accea97f90", size = 2138960, upload-time = "2025-11-04T13:41:14.627Z" },
    { url = "https://files.pythonhosted.org/packages/a6/62/205a998f4327d2079326b01abee48e502ea739d174f0a89295c481a2272e/pydantic_core-2.41.5-cp314-cp314-musllinux_1_1_armv7l.whl", hash = "sha256:63510af5e38f8955b8ee5687740d6ebf7c2a0886d15a6d65c32814613681bc07", size = 2339102, upload-time = "2025-11-04T13:41:16.868Z" },
    { url = "https://files.pythonhosted.org/packages/3c/0d/f05e79471e889d74d3d88f5bd20d0ed189ad94c2423d81ff8d0000aab4ff/pydantic_core-2.41.5-cp314-cp314-musllinux_1_1_x86_64.whl", hash = "sha256:e56ba91f47764cc14f1daacd723e3e82d1a89d783f0f5afe9c364b8bb491ccdb", size = 2326039, upload-time = "2025-11-04T13:41:18.934Z" },
    { url = "https://files.pythonhosted.org/packages/ec/e1/e08a6208bb100da7e0c4b288eed624a703f4d129bde2da475721a80cab32/pydantic_core-2.41.5-cp314-cp314-win32.whl", hash = "sha256:aec5cf2fd867b4ff45b9959f8b20ea3993fc93e63c7363fe6851424c8a7e7c23", size = 1995126, upload-time = "2025-11-04T13:41:21.418Z" },
    { url = "https://files.pythonhosted.org/packages/48/5d/56ba7b24e9557f99c9237e29f5c09913c81eeb2f3217e40e922353668092/pydantic_core-2.41.5-cp314-cp314-win_amd64.whl", hash = "sha256:8e7c86f27c585ef37c35e56a96363ab8de4e549a95512445b85c96d3e2f7c1bf", size = 2015489, upload-time = "2025-11-04T13:41:24.076Z" },
    { url = "https://files.pythonhosted.org/packages/4e/bb/f7a190991ec9e3e0ba22e4993d8755bbc4a32925c0b5b42775c03e8148f9/pydantic_core-2.41.5-cp314-cp314-win_arm64.whl", hash = "sha256:e672ba74fbc2dc8eea59fb6d4aed6845e6905fc2a8afe93175d94a83ba2a01a0", size = 1977288, upload-time = "2025-11-04T13:41:26.33Z" },
    { url = "https://files.pythonhosted.org/packages/92/ed/77542d0c51538e32e15afe7899d79efce4b81eee631d99850edc2f5e9349/pydantic_core-2.41.5-cp314-cp314t-macosx_10_12_x86_64.whl", hash = "sha256:8566def80554c3faa0e65ac30ab0932b9e3a5cd7f8323764303d468e5c37595a", size = 2120255, upload-time = "2025-11-04T13:41:28.569Z" },
    { url = "https://files.pythonhosted.org/packages/bb/3d/6913dde84d5be21e284439676168b28d8bbba5600d838b9dca99de0fad71/pydantic_core-2.41.5-cp314-cp314t-macosx_11_0_arm64.whl", hash = "sha256:b80aa5095cd3109962a298ce14110ae16b8c1aece8b72f9dafe81cf597ad80b3", size = 1863760, upload-time = "2025-11-04T13:41:31.055Z" },
    { url = "https://files.pythonhosted.org/packages/5a/f0/e5e6b99d4191da102f2b0eb9687aaa7f5bea5d9964071a84effc3e40f997/pydantic_core-2.41.5-cp314-cp314t-manylinux_2_17_aarch64.manylinux2014_aarch64.whl", hash = "sha256:3006c3dd9ba34b0c094c544c6006cc79e87d8612999f1a5d43b769b89181f23c", size = 1878092, upload-time = "2025-11-04T13:41:33.21Z" },
    { url = "https://files.pythonhosted.org/packages/71/48/36fb760642d568925953bcc8116455513d6e34c4beaa37544118c36aba6d/pydantic_core-2.41.5-cp314-cp314t-manylinux_2_17_armv7l.manylinux2014_armv7l.whl", hash = "sha256:72f6c8b11857a856bcfa48c86f5368439f74453563f951e473514579d44aa612", size = 2053385, upload-time = "2025-11-04T13:41:35.508Z" },
    { url = "https://files.pythonhosted.org/packages/20/25/92dc684dd8eb75a234bc1c764b4210cf2646479d54b47bf46061657292a8/pydantic_core-2.41.5-cp314-cp314t-manylinux_2_17_ppc64le.manylinux2014_ppc64le.whl", hash = "sha256:5cb1b2f9742240e4bb26b652a5aeb840aa4b417c7748b6f8387927bc6e45e40d", size = 2218832, upload-time = "2025-11-04T13:41:37.732Z" },
    { url = "https://files.pythonhosted.org/packages/e2/09/f53e0b05023d3e30357d82eb35835d0f6340ca344720a4599cd663dca599/pydantic_core-2.41.5-cp314-cp314t-manylinux_2_17_s390x.manylinux2014_s390x.whl", hash = "sha256:bd3d54f38609ff308209bd43acea66061494157703364ae40c951f83ba99a1a9", size = 2327585, upload-time = "2025-11-04T13:41:40Z" },
    { url = "https://files.pythonhosted.org/packages/aa/4e/2ae1aa85d6af35a39b236b1b1641de73f5a6ac4d5a7509f77b814885760c/pydantic_core-2.41.5-cp314-cp314t-manylinux_2_17_x86_64.manylinux2014_x86_64.whl", hash = "sha256:2ff4321e56e879ee8d2a879501c8e469414d948f4aba74a2d4593184eb326660", size = 2041078, upload-time = "2025-11-04T13:41:42.323Z" },
    { url = "https://files.pythonhosted.org/packages/cd/13/2e215f17f0ef326fc72afe94776edb77525142c693767fc347ed6288728d/pydantic_core-2.41.5-cp314-cp314t-manylinux_2_5_i686.manylinux1_i686.whl", hash = "sha256:d0d2568a8c11bf8225044aa94409e21da0cb09dcdafe9ecd10250b2baad531a9", size = 2173914, upload-time = "2025-11-04T13:41:45.221Z" },
    { url = "https://files.pythonhosted.org/packages/02/7a/f999a6dcbcd0e5660bc348a3991c8915ce6599f4f2c6ac22f01d7a10816c/pydantic_core-2.41.5-cp314-cp314t-musllinux_1_1_aarch64.whl", hash = "sha256:a39455728aabd58ceabb03c90e12f71fd30fa69615760a075b9fec596456ccc3", size = 2129560, upload-time = "2025-11-04T13:41:47.474Z" },
    { url = "https://files.pythonhosted.org/packages/3a/b1/6c990ac65e3b4c079a4fb9f5b05f5b013afa0f4ed6780a3dd236d2cbdc64/pydantic_core-2.41.5-cp314-cp314t-musllinux_1_1_armv7l.whl", hash = "sha256:239edca560d05757817c13dc17c50766136d21f7cd0fac50295499ae24f90fdf", size = 2329244, upload-time = "2025-11-04T13:41:49.992Z" },
    { url = "https://files.pythonhosted.org/packages/d9/02/3c562f3a51afd4d88fff8dffb1771b30cfdfd79befd9883ee094f5b6c0d8/pydantic_core-2.41.5-cp314-cp314t-musllinux_1_1_x86_64.whl", hash = "sha256:2a5e06546e19f24c6a96a129142a75cee553cc018ffee48a460059b1185f4470", size = 2331955, upload-time = "2025-11-04T13:41:54.079Z" },
    { url = "https://files.pythonhosted.org/packages/5c/96/5fb7d8c3c17bc8c62fdb031c47d77a1af698f1d7a406b0f79aaa1338f9ad/pydantic_core-2.41.5-cp314-cp314t-win32.whl", hash = "sha256:b4ececa40ac28afa90871c2cc2b9ffd2ff0bf749380fbdf57d165fd23da353aa", size = 1988906, upload-time = "2025-11-04T13:41:56.606Z" },
    { url = "https://files.pythonhosted.org/packages/22/ed/182129d83032702912c2e2d8bbe33c036f342cc735737064668585dac28f/pydantic_core-2.41.5-cp314-cp314t-win_amd64.whl", hash = "sha256:80aa89cad80b32a912a65332f64a4450ed00966111b6615ca6816153d3585a8c", size = 1981607, upload-time = "2025-11-04T13:41:58.889Z" },
    { url = "https://files.pythonhosted.org/packages/9f/ed/068e41660b832bb0b1aa5b58011dea2a3fe0ba7861ff38c4d4904c1c1a99/pydantic_core-2.41.5-cp314-cp314t-win_arm64.whl", hash = "sha256:35b44f37a3199f771c3eaa53051bc8a70cd7b54f333531c59e29fd4db5d15008", size = 1974769, upload-time = "2025-11-04T13:42:01.186Z" },
]

[[package]]
name = "pypdf"
version = "6.6.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/d8/f4/801632a8b62a805378b6af2b5a3fcbfd8923abf647e0ed1af846a83433b2/pypdf-6.6.0.tar.gz", hash = "sha256:4c887ef2ea38d86faded61141995a3c7d068c9d6ae8477be7ae5de8a8e16592f", size = 5281063, upload-time = "2026-01-09T11:20:11.786Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/b2/ba/96f99276194f720e74ed99905a080f6e77810558874e8935e580331b46de/pypdf-6.6.0-py3-none-any.whl", hash = "sha256:bca9091ef6de36c7b1a81e09327c554b7ce51e88dad68f5890c2b4a4417f1fd7", size = 328963, upload-time = "2026-01-09T11:20:09.278Z" },
]

[[package]]
name = "smart-parking"
version = "0.1.0"
source = { virtual = "." }
dependencies = [
    { name = "fastapi" },
    { name = "pypdf" },
    { name = "uvicorn" },
]

[package.metadata]
requires-dist = [
    { name = "fastapi", specifier = ">=0.128.0" },
    { name = "pypdf", specifier = ">=6.6.0" },
    { name = "uvicorn", specifier = ">=0.40.0" },
]

[[package]]
name = "starlette"
version = "0.50.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "anyio" },
]
sdist = { url = "https://files.pythonhosted.org/packages/ba/b8/73a0e6a6e079a9d9cfa64113d771e421640b6f679a52eeb9b32f72d871a1/starlette-0.50.0.tar.gz", hash = "sha256:a2a17b22203254bcbc2e1f926d2d55f3f9497f769416b3190768befe598fa3ca", size = 2646985, upload-time = "2025-11-01T15:25:27.516Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/d9/52/1064f510b141bd54025f9b55105e26d1fa970b9be67ad766380a3c9b74b0/starlette-0.50.0-py3-none-any.whl", hash = "sha256:9e5391843ec9b6e472eed1365a78c8098cfceb7a74bfd4d6b1c0c0095efb3bca", size = 74033, upload-time = "2025-11-01T15:25:25.461Z" },
]

[[package]]
name = "typing-extensions"
version = "4.15.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/72/94/1a15dd82efb362ac84269196e94cf00f187f7ed21c242792a923cdb1c61f/typing_extensions-4.15.0.tar.gz", hash = "sha256:0cea48d173cc12fa28ecabc3b837ea3cf6f38c6d1136f85cbaaf598984861466", size = 109391, upload-time = "2025-08-25T13:49:26.313Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/18/67/36e9267722cc04a6b9f15c7f3441c2363321a3ea07da7ae0c0707beb2a9c/typing_extensions-4.15.0-py3-none-any.whl", hash = "sha256:f0fa19c6845758ab08074a0cfa8b7aecb71c999ca73d62883bc25cc018c4e548", size = 44614, upload-time = "2025-08-25T13:49:24.86Z" },
]

[[package]]
name = "typing-inspection"
version = "0.4.2"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "typing-extensions" },
]
sdist = { url = "https://files.pythonhosted.org/packages/55/e3/70399cb7dd41c10ac53367ae42139cf4b1ca5f36bb3dc6c9d33acdb43655/typing_inspection-0.4.2.tar.gz", hash = "sha256:ba561c48a67c5958007083d386c3295464928b01faa735ab8547c5692e87f464", size = 75949, upload-time = "2025-10-01T02:14:41.687Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/dc/9b/47798a6c91d8bdb567fe2698fe81e0c6b7cb7ef4d13da4114b41d239f65d/typing_inspection-0.4.2-py3-none-any.whl", hash = "sha256:4ed1cacbdc298c220f1bd249ed5287caa16f34d44ef4e9c3d0cbad5b521545e7", size = 14611, upload-time = "2025-10-01T02:14:40.154Z" },
]

[[package]]
name = "uvicorn"
version = "0.40.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "click" },
    { name = "h11" },
]
sdist = { url = "https://files.pythonhosted.org/packages/c3/d1/8f3c683c9561a4e6689dd3b1d345c815f10f86acd044ee1fb9a4dcd0b8c5/uvicorn-0.40.0.tar.gz", hash = "sha256:839676675e87e73694518b5574fd0f24c9d97b46bea16df7b8c05ea1a51071ea", size = 81761, upload-time = "2025-12-21T14:16:22.45Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/3d/d8/2083a1daa7439a66f3a48589a57d576aa117726762618f6bb09fe3798796/uvicorn-0.40.0-py3-none-any.whl", hash = "sha256:c6c8f55bc8bf13eb6fa9ff87ad62308bbbc33d0b67f84293151efe87e0d5f2ee", size = 68502, upload-time = "2025-12-21T14:16:21.041Z" },
]

import sys
import time
from core.logic import ParkingLogic, store
from core.models import ParkingState

def assert_true(condition, msg):
    if not condition:
        print(f"FAILED: {msg}")
        sys.exit(1)
    else:
        print(f"PASSED: {msg}")

def run_verification():
    print("--- Starting Analytics Verification ---")
    
    # 1. Setup
    store.reset() # Clear previous state
    ParkingLogic.create_zone("Z1", "Premium", 2, [])
    
    # 2. Trip 1: 1 second duration
    print("\n1. Simulating Trip 1 (1 sec)...")
    v1 = ParkingLogic.register_vehicle("CAR-A", "Z1")
    req1 = ParkingLogic.request_parking("CAR-A", "Z1")
    res = ParkingLogic.allocate_slot(req1.id)
    assert_true(res["success"], "Allocation successful")
    ParkingLogic.occupy_slot(req1.id)
    time.sleep(1.1)
    ParkingLogic.release_slot(req1.id)
    
    assert_true(req1.state == ParkingState.RELEASED, "Request 1 RELEASED")
    assert_true(req1.end_time is not None, "End time set")
    duration = req1.end_time - req1.request_time
    print(f"   Duration: {duration:.2f}s")
    assert_true(duration >= 1.0, "Duration tracked")

    # 3. Trip 2: Cancelled
    print("\n2. Simulating Trip 2 (Cancelled)...")
    req2 = ParkingLogic.request_parking("CAR-B", "Z1")
    ParkingLogic.cancel_request(req2.id)
    assert_true(req2.state == ParkingState.CANCELLED, "Request 2 CANCELLED")

    # 4. Check Analytics Logic (Manual Check matching API logic)
    print("\n3. Verifying Analytics Logic...")
    
    # Utilization (Should be 0/2 as Trip 1 released)
    zone = store.zones["Z1"]
    z1_slots = [s for area in zone.parking_areas for s in area.slots]
    occupied = sum(1 for s in z1_slots if not s.is_available)
    assert_true(occupied == 0, "Zone Z1 is empty")
    
    # Avg Duration
    released = [r for r in store.request_log if r.state == ParkingState.RELEASED]
    total_dur = sum(r.end_time - r.request_time for r in released)
    avg = total_dur / len(released)
    print(f"   Avg Duration: {avg:.2f}s")
    assert_true(avg >= 1.0, "Avg Duration correct")
    
    # Breakdown
    cancelled = sum(1 for r in store.request_log if r.state == ParkingState.CANCELLED)
    completed = len(released)
    assert_true(cancelled == 1, "Cancelled count correct")
    assert_true(completed == 1, "Completed count correct")
    
    # Peak Zones
    # Trip 1 was allocated in Z1. Trip 2 (Request) Z1.
    # Logic counts allocations. Trip 2 was cancelled before allocation? 
    # Logic: request_parking -> ALLOCATED -> CANCELLED/RELEASED.
    # My test script for Trip 2 called cancel_request immediately after request_parking. 
    # StateMachine check: REQUESTED -> ALLOCATED (if allocated) -> CANCELLED.
    # If cancelled from REQUESTED, it was never allocated.
    # Trip 1 was allocated.
    count_z1 = 0
    for r in store.request_log:
         if r.state in [ParkingState.ALLOCATED, ParkingState.RELEASED, ParkingState.OCCUPIED] and r.zone_id == "Z1":
             count_z1 += 1
    assert_true(count_z1 == 1, "Peak zone count correct (1 allocation)")

    print("\n--- Analytics Verification Completed Successfully ---")

if __name__ == "__main__":
    try:
        run_verification()
    except Exception as e:
        print(f"CRITICAL ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

import sys
import time
from core.logic import ParkingLogic, store
from core.models import ParkingState

def assert_true(condition, msg):
    if not condition:
        print(f"FAILED: {msg}")
        sys.exit(1)
    else:
        print(f"PASSED: {msg}")

def run_verification():
    print("--- Starting Verification ---")
    
    # 1. Setup Data
    print("\n1. Setting up Zones...")
    z1 = ParkingLogic.create_zone("Z1", "Premium", 2, ["Z2"])
    z2 = ParkingLogic.create_zone("Z2", "Standard", 2, ["Z1"])
    assert_true(len(store.zones) == 2, "Zones created")
    
    # 2. Register Vehicle
    print("\n2. Registering Vehicle...")
    v1 = ParkingLogic.register_vehicle("CAR-A", "Z1")
    assert_true(v1.preferred_zone_id == "Z1", "Vehicle registered with pref Z1")

    # 3. Request & Allocate (Normal)
    print("\n3. Testing Normal Allocation...")
    req1 = ParkingLogic.request_parking("CAR-A", "Z1")
    res1 = ParkingLogic.allocate_slot(req1.id)
    assert_true(res1["success"], "Allocation successful")
    assert_true(res1["type"] == "PRIMARY", "Allocation type is PRIMARY")
    assert_true(req1.state == ParkingState.ALLOCATED, "Request state is ALLOCATED")
    assert_true(req1.allocated_slot_id.startswith("Z1"), "Allocated in Preferred Zone (Z1)")
    
    # 4. Fill Z1
    print("\n4. Filling Z1...")
    v2 = ParkingLogic.register_vehicle("CAR-B", "Z1")
    req2 = ParkingLogic.request_parking("CAR-B", "Z1")
    ParkingLogic.allocate_slot(req2.id)
    assert_true(req2.allocated_slot_id.startswith("Z1"), "2nd car in Z1")
    
    # 5. Cross-Zone Allocation (Penalty)
    print("\n5. Testing Zone Full Blocking...")
    v3 = ParkingLogic.register_vehicle("CAR-C", "Z1") # Pref Z1, but full
    req3 = ParkingLogic.request_parking("CAR-C", "Z1")
    res3 = ParkingLogic.allocate_slot(req3.id)
    assert_true(not res3["success"], "Cross-zone allocation blocked (Target behavior)")
    assert_true(res3["type"] == "FULL", "Allocation type is FULL")

    # 6. Rollback
    print("\n6. Testing Rollback...")
    # Rollback last operation (CAR-C allocation)
    ParkingLogic.rollback(1)
    
    # CAR-C request should be pending again, slot in Z2 free
    req3_updated = store.requests[req3.id]
    assert_true(req3_updated.state == ParkingState.REQUESTED, "Request rolled back to REQUESTED")
    assert_true(req3_updated.allocated_slot_id is None, "Slot de-allocated")
    
    # Check Z2 slot availability
    z2 = store.zones["Z2"]
    z2_slots = [s for area in z2.parking_areas for s in area.slots]
    occupied_count = sum(1 for s in z2_slots if not s.is_available)
    assert_true(occupied_count == 0, "Z2 slot freed")

    # 7. Testing Full Lifecycle (Occupy & Release)
    print("\n7. Testing Full Lifecycle (Occupy & Release)...")
    res3_retry = ParkingLogic.allocate_slot(req3.id)
    assert_true(res3_retry["success"], "Re-allocation as step 1")
    
    ParkingLogic.occupy_slot(req3.id)
    assert_true(req3_updated.state == ParkingState.OCCUPIED, "State is OCCUPIED")
    
    ParkingLogic.release_slot(req3.id)
    assert_true(req3_updated.state == ParkingState.RELEASED, "State is RELEASED")
    assert_true(req3_updated.end_time is not None, "End time recorded")
    
    # Check slot is free
    z2_slots_final = [s for area in z2.parking_areas for s in area.slots]
    occupied_count_final = sum(1 for s in z2_slots_final if not s.is_available)
    assert_true(occupied_count_final == 0, "Slot freed after release")

    print("\n--- Verification Completed Successfully ---")

if __name__ == "__main__":
    try:
        run_verification()
    except Exception as e:
        print(f"CRITICAL ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

