"""Adds the site condition columns to extra/stations.csv and refreshes arv.

Two regional mesh datasets are used, both read through jismesh:

* extra/Z-V4-JAPAN-AMP-VS400_M250.csv -- 250 m mesh (jismesh level 5), header
  `CODE, JCODE, AVS, ARV, AVS_EB, AVS_REF`
      AVS -> avs30        ARV -> arv
* extra/D-V3.2-STRUCT_DEEP-LYRD.csv -- 1 km mesh (jismesh level 3), header
  `CODE, S0, D0, D1, ..., D17, ...`
      D17 -> d1400
"""

import csv
import math
import os

import jismesh.utils

STATIONS_PATH = "extra/stations.csv"

Z_V4_PATH = "extra/Z-V4-JAPAN-AMP-VS400_M250.csv"
DEEP_PATH = "extra/D-V3.2-STRUCT_DEEP-LYRD.csv"

# Column of each output column inside its source file, counting from 0 where 0
# is the mesh code itself.
Z_V4_COLUMNS = {"arv": 3, "avs30": 2}   # ARV, AVS on the 250 m mesh
DEEP_COLUMNS = {"d1400": 19}            # D17 on the 1 km mesh

OUTPUT_COLUMNS = ["code", "nameja", "kana", "nameen", "lat", "lon", "citycode",
                  "arv", "avs30", "d1400"]
BASE_COLUMNS = OUTPUT_COLUMNS[:8]       # what stations.csv already provides

# Search radius, in mesh cells, handed to stations whose ARV/AVS cell has no
# data. Every round covers a whole square, so the nearest cell found within it
# is really the nearest one; the round after it is only needed by stations that
# sit on an island the dataset does not cover. d1400 is not searched at all.
Z_V4_RADII = (8, 16)
DEEP_RADII = ()


def haversine_distance(lat1, lon1, lat2, lon2):
    """Distance between two points, in kilometres."""
    radius = 6371.0088
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return 2 * radius * math.asin(math.sqrt(a))


class Search:
    """A station position looking for a value on one mesh grid."""

    __slots__ = ("grid", "values", "lat", "lon", "code", "cells", "known")

    def __init__(self, grid, values, lat, lon, code):
        self.grid = grid
        self.values = values          # {column name: value or None}, filled in
        self.lat = lat
        self.lon = lon
        self.code = code
        self.cells = []               # (distance in km, mesh code), nearest first
        self.known = set()            # mesh codes already collected

    @property
    def complete(self):
        return None not in self.values.values()

    def grow(self, codes):
        """Collect the cells of the area that was just fetched, by distance."""
        for code in codes:
            if code in self.known or code not in self.grid.rows:
                continue
            self.known.add(code)
            self.cells.append((self.grid.distance_to_cell(self.lat, self.lon, code),
                               code))
        self.cells.sort()

    def nearest(self, column):
        """Value of the nearest cell that carries one, or None."""
        for _, code in self.cells:            # sorted, so the first hit is nearest
            value = self.grid.value(code, self.grid.columns[column])
            if value is not None:
                return value
        return None


class MeshGrid:
    """Random access to the columns of one regional mesh CSV.

    Mesh codes are cached, and every batch of new codes costs a single pass over
    the (large) source file, so the stations that need a fallback cell are
    searched round by round instead of triggering a file scan each on their own.
    """

    def __init__(self, path, level, columns, radii, zero_is_nodata=True):
        self.path = path
        self.level = level
        self.columns = columns        # {column name: column index}
        self.radii = radii            # search radius per round, in mesh cells
        self.zero_is_nodata = zero_is_nodata   # is 0 a real value here?
        self.rows = {}                # mesh code -> split fields of a line
        self.absent = set()           # mesh codes the file does not contain
        self.searches = []            # station positions still unresolved
        self.fallbacks = 0
        self.unit_lat = jismesh.utils.unit_lat(level)
        self.unit_lon = jismesh.utils.unit_lon(level)

    # -- mesh helpers --------------------------------------------------
    def mesh_code(self, lat, lon):
        """Mesh code of a point, or None when it is out of the mesh system."""
        try:
            return str(jismesh.utils.to_meshcode(lat, lon, self.level))
        except ValueError:
            return None

    def distance_to_cell(self, lat, lon, code):
        """Distance from a point to the closest edge of a mesh, in km."""
        base_lat, base_lon = jismesh.utils.to_meshpoint(code, 0, 0)
        base_lat, base_lon = float(base_lat), float(base_lon)
        near_lat = min(max(lat, base_lat), base_lat + self.unit_lat)
        near_lon = min(max(lon, base_lon), base_lon + self.unit_lon)
        return haversine_distance(lat, lon, near_lat, near_lon)

    def square_codes(self, code, radius):
        """Mesh codes within `radius` cells of `code`, `code` excluded.

        The offsets are taken from the centre of the cell, so every candidate
        point lands in the middle of a mesh instead of on a border, where the
        mesh code of a point is at the mercy of floating point rounding.
        """
        if code is None:
            return set()
        lat, lon = jismesh.utils.to_meshpoint(code, 0.5, 0.5)
        lat, lon = float(lat), float(lon)
        codes = set()
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                if dy == 0 and dx == 0:
                    continue
                mesh = self.mesh_code(lat + dy * self.unit_lat,
                                      lon + dx * self.unit_lon)
                if mesh is not None:
                    codes.add(mesh)
        return codes

    # -- source file ---------------------------------------------------
    def fetch(self, codes):
        """Cache the given mesh codes; costs a single pass over the file."""
        wanted = set(codes)
        wanted -= self.rows.keys()
        wanted -= self.absent
        if not wanted:
            return
        with open(self.path, "r", encoding="utf-8") as f:
            for line in f:
                code = line.partition(",")[0]
                if code in wanted:
                    self.rows[code] = line.split(",")
                    wanted.discard(code)
                    if not wanted:
                        break
        # whatever is left over is not part of the file
        self.absent.update(wanted)

    def value(self, code, index):
        """Value of a column in a cell, or None if the cell holds no data.

        For ARV/AVS a 0 means "outside the mesh" and has to be replaced, for
        d1400 it is a value like any other. A cell that the file does not have
        is missing data either way.
        """
        fields = self.rows.get(code)
        if fields is None or index >= len(fields):
            return None
        value = fields[index].strip()
        if not value:
            return None
        try:
            if float(value) == 0.0 and self.zero_is_nodata:
                return None
        except ValueError:
            return None
        return value

    # -- lookups -------------------------------------------------------
    def lookup(self, lat, lon, code):
        """Values of this grid for a station; `code` must be cached already."""
        values = {column: None for column in self.columns}
        for column, index in self.columns.items():
            values[column] = self.value(code, index)
        if all(value is not None for value in values.values()):
            return values
        # the station sits outside the sampled mesh, look for the nearest cell
        self.searches.append(Search(self, values, lat, lon, code))
        return values

    def resolve(self):
        """Hand every unresolved station the nearest cell that has data."""
        searches = self.searches
        missing = len(searches)
        for radius in self.radii:
            if not searches:
                break
            self.expand(searches, radius)
            searches = [search for search in searches if not search.complete]
        self.fallbacks = missing - len(searches)
        for search in searches:
            for column, value in search.values.items():
                if value is None:
                    searched = (f"within {self.radii[-1]} cells"
                                if self.radii else "in the dataset")
                    print(f"Warning: no {column} value {searched} around "
                          f"{search.lat}/{search.lon}, leaving it empty")
        self.searches = []

    def expand(self, searches, radius):
        """Search a larger area and fill in whatever is found."""
        squares = [self.square_codes(search.code, radius) for search in searches]
        wanted = set()
        for square in squares:
            wanted |= square
        self.fetch(wanted)
        for search, square in zip(searches, squares):
            search.grow(square)
            for column in self.columns:
                if search.values[column] is None:
                    search.values[column] = search.nearest(column)


def read_stations():
    """Rows of extra/stations.csv, padded to the expected column count."""
    stations = []
    with open(STATIONS_PATH, "r", encoding="utf-8") as f:
        reader = csv.reader(f, delimiter=";")
        header = [column.strip() for column in next(reader)]
        if header[:len(BASE_COLUMNS)] != BASE_COLUMNS:
            raise SystemExit(f"Unexpected header in {STATIONS_PATH}: {header}")
        if any(column not in OUTPUT_COLUMNS for column in header[len(BASE_COLUMNS):]):
            raise SystemExit(f"Unexpected columns in {STATIONS_PATH}: {header}")
        for row in reader:
            if not row:
                continue
            if len(row) < len(OUTPUT_COLUMNS) - 1:
                row = row + [""] * (len(OUTPUT_COLUMNS) - 1 - len(row))
            stations.append(row)
    return stations


def main():
    stations = read_stations()

    # position of every station, None when it has no coordinates
    points = []
    for row in stations:
        lat, lon = row[4].strip(), row[5].strip()
        if lat and lon:
            points.append((float(lat), float(lon)))
        else:
            points.append(None)
            print(f"Warning: {row[1]} has no coordinates, leaving values empty")

    grids = [
        # ARV/AVS: a cell with no data (0) means the station is outside the mesh
        # and needs the nearest non-zero cell.
        MeshGrid(Z_V4_PATH, 5, Z_V4_COLUMNS, Z_V4_RADII, zero_is_nodata=True),
        # d1400: 0 is a value, so only a cell missing altogether is a problem.
        MeshGrid(DEEP_PATH, 3, DEEP_COLUMNS, DEEP_RADII, zero_is_nodata=False),
    ]

    # the mesh code of every station, on every grid, in one pass each
    codes_per_grid = []
    for grid in grids:
        print(f"Loading {grid.path} ...")
        codes = [None if point is None else grid.mesh_code(*point)
                 for point in points]
        grid.fetch({code for code in codes if code is not None})
        codes_per_grid.append(codes)

    values_per_station = []
    for index, point in enumerate(points):
        # one dict per grid: they are filled in later, once the fallback cells
        # are known, so they have to stay separate objects
        values = []
        for grid, codes in zip(grids, codes_per_grid):
            values.append(grid.lookup(point[0], point[1], codes[index]))
        values_per_station.append(values)

    # stations without an ARV/AVS cell of their own need the nearest one
    for grid in grids:
        grid.resolve()

    out_path = STATIONS_PATH + ".tmp"
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(";".join(OUTPUT_COLUMNS) + "\n")
        for row, value_dicts in zip(stations, values_per_station):
            merged = {}
            for value_dict in value_dicts:
                merged.update(value_dict)
            cells = row[:7]
            cells += [merged.get(column) or "" for column in OUTPUT_COLUMNS[7:]]
            f.write(";".join(cells) + "\n")
    os.replace(out_path, STATIONS_PATH)

    print(f"Updated {len(stations)} stations "
          f"({sum(1 for point in points if point is None)} without coordinates).")
    for grid in grids:
        print(f"{os.path.basename(grid.path)}: {len(grid.rows)} cells loaded, "
              f"{grid.fallbacks} stations took the nearest non-zero cell.")


if __name__ == "__main__":
    main()
