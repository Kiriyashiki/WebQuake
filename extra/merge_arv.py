import json
import csv
import jismesh.utils
import math

def point_in_polygon(point, polygon):
    px, py = point
    def check_ring(ring):
        inside = False
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if yj - yi != 0:
                intersect = ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi)
                if intersect:
                    inside = not inside
            j = i
        return inside

    geom_type = polygon.get("type")
    coords = polygon.get("coordinates")
    if not coords: return False
    
    if geom_type == "Polygon":
        inside = check_ring(coords[0])
        for ring in coords[1:]:
            if check_ring(ring):
                inside = not inside
        return inside
    elif geom_type == "MultiPolygon":
        for poly in coords:
            if not poly: continue
            inside = check_ring(poly[0])
            for ring in poly[1:]:
                if check_ring(ring):
                    inside = not inside
            if inside:
                return True
        return False
    return False

def haversine_distance(lat1, lon1, lat2, lon2):
    R = 6371
    dLat = (lat2 - lat1) * math.pi / 180
    dLon = (lon2 - lon1) * math.pi / 180
    a = math.sin(dLat / 2) * math.sin(dLat / 2) + \
        math.cos(lat1 * math.pi / 180) * math.cos(lat2 * math.pi / 180) * \
        math.sin(dLon / 2) * math.sin(dLon / 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

# Load Geo Data
print("Loading geo data...")
with open('public/municipalities.geojson', 'r', encoding='utf-8') as f:
    municipalities = json.load(f)

city_polygons = {}
for feature in municipalities.get('features', []):
    props = feature.get('properties', {})
    geom = feature.get('geometry', {})
    rc = props.get('regioncode')
    if rc and geom:
        city_polygons[str(rc)] = feature

with open('public/bounds.json', 'r', encoding='utf-8') as f:
    bounds_data = json.load(f)
city_bounds = bounds_data.get('cities', {})

# 1. Load stations.json
nameja_to_coord = {}
with open('extra/stations.json', 'r', encoding='utf-8') as f:
    stations_json = json.load(f)
    for item in stations_json:
        nameja_to_coord[item['name']] = (item['lat'], item['lon'])

# 2. Read extra/stations.csv and prepare needed mesh codes
stations = []
mesh_codes_needed = set()

with open('extra/stations.csv', 'r', encoding='utf-8') as f:
    reader = csv.reader(f, delimiter=';')
    header = next(reader) # code;nameja;kana;nameen
    for row in reader:
        if len(row) < 4:
            continue
        code, nameja, kana, nameen = row[:4]
        if nameja in nameja_to_coord:
            lat, lon = nameja_to_coord[nameja]
            mesh = jismesh.utils.to_meshcode(float(lat), float(lon), 5)
            # meshcode from jismesh can be int, convert to string
            mesh = str(mesh)
            mesh_codes_needed.add(mesh)
            stations.append({
                'code': code,
                'nameja': nameja,
                'kana': kana,
                'nameen': nameen,
                'lat': lat,
                'lon': lon,
                'mesh': mesh
            })
        else:
            print(f"Warning: {nameja} not found in stations.json")
            stations.append({
                'code': code,
                'nameja': nameja,
                'kana': kana,
                'nameen': nameen,
                'lat': '',
                'lon': '',
                'mesh': None
            })

# 3. Read CSV and extract ARV for needed mesh codes
mesh_to_arv = {}
print(f"Looking up {len(mesh_codes_needed)} mesh codes...")
with open('extra/Z-V4-JAPAN-AMP-VS400_M250.csv', 'r', encoding='utf-8') as f:
    for line in f:
        if line.startswith('#'):
            continue
        parts = line.split(',')
        if len(parts) >= 4:
            mesh_code = parts[0].strip()
            if mesh_code in mesh_codes_needed:
                arv = parts[3].strip()
                mesh_to_arv[mesh_code] = arv
                
print(f"Found ARV values for {len(mesh_to_arv)} mesh codes.")

# Assign city code to each station
print("Assigning city codes to stations...")
search_radius_deg = 0.1
for s in stations:
    if not s['lat'] or not s['lon']:
        s['city_code'] = ''
        continue
    
    slat = float(s['lat'])
    slon = float(s['lon'])
    point = [slon, slat]
    
    best_city = None
    
    # Fast Bounding Box & Point in Polygon Filter
    for city_code, bbox in city_bounds.items():
        min_lon, min_lat, max_lon, max_lat = bbox
        if min_lon <= slon <= max_lon and min_lat <= slat <= max_lat:
            feature = city_polygons.get(city_code)
            if feature and point_in_polygon(point, feature['geometry']):
                best_city = city_code
                break
                
    # Fallback logic if not perfectly inside polygon (e.g. on coast)
    if not best_city:
        min_dist = 10 # 10km search radius
        for city_code, bbox in city_bounds.items():
            min_lon, min_lat, max_lon, max_lat = bbox
            if (min_lon - search_radius_deg <= slon <= max_lon + search_radius_deg and
                min_lat - search_radius_deg <= slat <= max_lat + search_radius_deg):
                
                feature = city_polygons.get(city_code)
                if not feature: continue
                
                city_min_dist = float('inf')
                geom_type = feature['geometry'].get('type')
                coords = feature['geometry'].get('coordinates')
                
                def get_ring_min_dist(ring):
                    r_min = float('inf')
                    for lon, lat in ring:
                        dist = haversine_distance(slat, slon, lat, lon)
                        if dist < r_min:
                            r_min = dist
                    return r_min
                            
                if geom_type == 'Polygon':
                    for ring in coords:
                        city_min_dist = min(city_min_dist, get_ring_min_dist(ring))
                elif geom_type == 'MultiPolygon':
                    for poly in coords:
                        for ring in poly:
                            city_min_dist = min(city_min_dist, get_ring_min_dist(ring))
                        
                if city_min_dist < min_dist:
                    min_dist = city_min_dist
                    best_city = city_code
                    
    s['city_code'] = best_city if best_city else ''

# 4. Write output to stations_arv.csv
with open('extra/stations_arv.csv', 'w', encoding='utf-8') as f:
    f.write('code;nameja;kana;nameen;lat;lon;citycode;arv\n')
    for s in stations:
        arv = mesh_to_arv.get(s['mesh'], '') if s['mesh'] else ''
        f.write(f"{s['code']};{s['nameja']};{s['kana']};{s['nameen']};{s['lat']};{s['lon']};{s['city_code']};{arv}\n")

print("Done. Wrote extra/stations_arv.csv")
