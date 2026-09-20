export {
  type CastleTemplate,
  type DetectedCastle,
  type DetectedCastleAt,
  detectCastles,
  findCastle,
  KNOWN_CASTLES,
  recordCastles,
} from './castle.ts'
export { ancestorTemplates, categoryRollup, dropUnestablishedChildren } from './hierarchy.ts'
export {
  detectTemplates,
  hasBishopExchangeConstraint,
  hasDropConstraint,
  hasFinishConstraint,
  hasHistoryRequirement,
  hasPlyConstraint,
  matchesFinishMove,
  matchesTemplate,
  satisfiesPlyConstraint,
  usesDroppedPiece,
} from './match.ts'
export { MoveHistory } from './move-history.ts'
export { PositionOnlyHistory, positionOnlyHistory } from './position-history.ts'
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
  PieceInSquares,
  PiecePlacement,
  PieceUnmoved,
  PieceVisited,
  rotate,
  type TemplateSquare,
} from './requirements.ts'
export {
  buildMoves,
  type RecordTemplatesOptions,
  recordTemplates,
  recordTemplatesWithDropped,
} from './scan.ts'
export {
  type DetectedStrategy,
  type DetectedStrategyAt,
  detectStrategies,
  findStrategy,
  KNOWN_STRATEGIES,
  recordStrategies,
  type StrategyTemplate,
} from './strategy.ts'
export type {
  BishopExchange,
  DetectedTemplate,
  DetectedTemplateAt,
  FormationSide,
  FormationTemplate,
  TemplateFinishCapture,
  TemplateFinishMove,
} from './template.ts'
