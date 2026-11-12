import { readFileSync } from "node:fs";
import type { PlantPlacement, SimInput, SpeciesRecord, SubstrateInput } from "../src/contract";

/** Snapshot of aquascape-botany data/plants.json (engine-relevant fields only). */
export const SPECIES: Record<string, SpeciesRecord> = JSON.parse(
  readFileSync(new URL("./fixtures/species.json", import.meta.url), "utf8"),
);

/** A typical 60P (60×30×36) mixed scape: background stems, midground rosettes/epiphytes, carpet. */
export function typicalScape(opts: {
  days?: number;
  substrate?: SubstrateInput;
  seed?: number;
  gridX?: number;
  dosing?: SimInput["dosing"];
  plants?: number;
} = {}): SimInput {
  const layout: [string, number, number, number][] = [
    // speciesId, x, z, y
    ["rotala-rotundifolia", -24, -11, 0],
    ["rotala-rotundifolia", -18, -12, 0],
    ["hygrophila-polysperma", -10, -12, 0],
    ["limnophila-sessiliflora", -3, -12, 0],
    ["ludwigia-repens", 4, -12, 0],
    ["bacopa-caroliniana", 11, -12, 0],
    ["rotala-macrandra", 17, -11, 0],
    ["hygrophila-corymbosa", 24, -11, 0],
    ["cryptocoryne-wendtii", -20, -3, 0],
    ["cryptocoryne-wendtii", 20, -3, 0],
    ["echinodorus-red-flame", 0, -5, 0],
    ["cryptocoryne-balansae", -12, -6, 0],
    ["microsorum-pteropus-narrow", 9, -3, 6],
    ["anubias-barteri-nana-petite", -6, 0, 5],
    ["bucephalandra-kedagang", 6, 1, 4],
    ["staurogyne-repens", -14, 4, 0],
    ["staurogyne-repens", 14, 4, 0],
    ["cryptocoryne-parva", -22, 8, 0],
    ["cryptocoryne-parva", 22, 8, 0],
    ["echinodorus-tenellus", -16, 10, 0],
    ["echinodorus-tenellus", 16, 10, 0],
    ["micranthemum-tweediei-monte-carlo", -8, 10, 0],
    ["micranthemum-tweediei-monte-carlo", 0, 11, 0],
    ["micranthemum-tweediei-monte-carlo", 8, 10, 0],
    ["eleocharis-parvula", -4, 6, 0],
    ["eleocharis-parvula", 4, 6, 0],
    ["marsilea-hirsuta", 0, 3, 0],
    ["taxiphyllum-barbieri", -2, -1, 8],
    ["bacopa-monnieri", -26, 0, 0],
    ["ludwigia-palustris", 26, 0, 0],
  ];
  const n = opts.plants ?? layout.length;
  const plants: PlantPlacement[] = layout.slice(0, n).map(([speciesId, x, z, y], i) => ({
    id: `p${i}-${speciesId}`, speciesId, x, z, y, portions: 1 + (i % 3 === 0 ? 1 : 0),
  }));
  return {
    tank: { widthCm: 60, depthCm: 30, heightCm: 36 },
    light: { surfacePar: 200, photoperiodH: 7, coverage: 0.9 },
    water: { temperatureC: 24.5, pH: 6.6, gh: 5, kh: 3, co2Ppm: 25 },
    dosing: opts.dosing ?? { no3: 0, po4: 0, k: 0, fe: 0 },
    plants,
    species: SPECIES,
    days: opts.days ?? 90,
    seed: opts.seed ?? 42,
    gridX: opts.gridX ?? 24,
    substrate: opts.substrate,
  };
}
