/* Shared satellite basemap and framing for both Explorer layers. */
const HOME = [[94.5, -7], [119.5, 8]];

export const explorerCamera = {
  center: [107, 1], zoom: 4.4, pitch: 30, maxPitch: 62, minZoom: 0.8, maxZoom: 15,
  attributionControl: false, dragRotate: true,
};

export function regionBounds(regions) {
  if (!regions.length) return null;
  return [
    Math.min(...regions.map(({ bbox }) => bbox[0])),
    Math.min(...regions.map(({ bbox }) => bbox[1])),
    Math.max(...regions.map(({ bbox }) => bbox[2])),
    Math.max(...regions.map(({ bbox }) => bbox[3])),
  ];
}

export function frameExplorerMap(map, focus, duration) {
  const { clientWidth, clientHeight } = map.getContainer();
  if (!clientWidth || !clientHeight) return;
  const padding = Math.min(60, clientWidth * 0.12, clientHeight * 0.12);
  // A country outside the regional forecast is framed by centre + zoom, which
  // handles countries that cross the date line without a world-wide bbox.
  if (focus && !Array.isArray(focus) && focus.center) {
    map.flyTo({
      center: focus.center,
      zoom: focus.zoom ?? 5,
      pitch: 30,
      bearing: 0,
      duration,
    });
    return;
  }
  const bounds = Array.isArray(focus) ? focus : focus?.bounds;
  const target = bounds ? [[bounds[0], bounds[1]], [bounds[2], bounds[3]]] : HOME;
  map.fitBounds(target, { padding, pitch: 30, bearing: 0, maxZoom: 10, duration });
}

export function satelliteStyle() {
  return {
    version: 8,
    projection: { type: "globe" },
    sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0] },
    sources: {
      sat: { type: "raster", tileSize: 256, maxzoom: 17, attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"] },
      bm: { type: "raster", tileSize: 256, maxzoom: 8, attribution: "NASA Blue Marble (GIBS)",
        tiles: ["https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg"] },
      places: { type: "raster", tileSize: 256, maxzoom: 13,
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"] },
      dem: { type: "raster-dem", tileSize: 256, maxzoom: 9, encoding: "terrarium", attribution: "Terrain: AWS Terrain Tiles",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"] },
      countries: { type: "geojson", data: new URL("./assets/countries.geojson", import.meta.url).href },
    },
    layers: [
      { id: "space", type: "background", paint: { "background-color": "#0a1826" } },
      { id: "sat", type: "raster", source: "sat", paint: { "raster-fade-duration": 120 } },
      // NASA Blue Marble on top while far away; it fades out as the sharper imagery takes over
      { id: "bm", type: "raster", source: "bm", maxzoom: 7, paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 4.5, 1, 6.5, 0] } },
      { id: "places", type: "raster", source: "places", minzoom: 4.5, maxzoom: 13.4, paint: { "raster-opacity": 0.9 } },
      { id: "country-line", type: "line", source: "countries", paint: { "line-color": "#ffffff", "line-opacity": 0.28, "line-width": 0.6 } },
    ],
  };
}
