export {
  type CastleTemplate,
  type DetectedCastle,
  type DetectedCastleAt,
  detectCastles,
  findCastle,
  hasHistoryRequirement,
  hasPlyConstraint,
  KNOWN_CASTLES,
  matchesTemplate,
  recordCastles,
  satisfiesPlyConstraint,
} from './castle.ts'
export { MoveHistory } from './move-history.ts'
export {
  type DetectedTechnique,
  KNOWN_TECHNIQUES,
  type TechniqueTemplate,
  detectTechniquesAtMove,
  recordTechniques,
  recordTechniquesFirstOccurrence,
} from './technique.ts'
export {
  type DetectedProverb,
  KNOWN_PROVERBS,
  type ProverbPattern,
  type ProverbRelation,
  detectProverbsAtMove,
  recordProverbs,
} from './proverb.ts'
export {
  AnyOfPieces,
  AnyPiece,
  type CastleRequirement,
  EmptySquare,
  HandPiece,
  isHistoryRequirement,
  KingIgyoku,
  NotOfPieces,
  opensHostilities,
  PieceAnywhere,
  PiecePlacement,
  PieceUnmoved,
  PieceVisited,
  rotate,
} from './requirements.ts'
