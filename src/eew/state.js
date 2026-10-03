/**
 * Shared state for the EEW (Earthquake Early Warning) subsystem.
 */
export const eewState = {
  activeEews: new Map(), // EventID -> EEW Object
  mapInstance: null,
  featureBounds: null,
  cityNames: null,
  areaCodes: null,
  eewEpicenterMarkers: [],
  isEewMapActive: false,
  isUserInteractingWithMap: false,
  mapInteractionTimeout: null,
  previousReport: null,
  carouselIndex: 0,
  carouselTimer: null,
};
