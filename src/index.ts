export {
  type DetectedCastle,
  type DetectedCastleAt,
  detectCastles,
  findCastle,
  KNOWN_CASTLES,
  recordCastles,
} from './castle.ts'
export {
  cellFromToken,
  type CellSide,
  flipCellSide,
  normalizeCell,
  PIECE_ORDER,
  PIECE_SFEN,
  type TemplateCell,
  tokenFromCell,
} from './cell-token.ts'
export {
  type CellEdit,
  type CellSpan,
  extractGrid,
  type GridExtraction,
  type GridRow,
  replaceCellToken,
  replaceCellTokens,
  type TemplateGrid,
} from './grid-text.ts'
export {
  addHeaderRequirement,
  isHeaderRequirement,
  removeHeaderRequirement,
  updateHeaderRequirement,
} from './header-requirement.ts'
export {
  type HeaderLine,
  headerLines,
  insertHeaderLine,
  readTemplateName,
  setHeaderField,
  setTemplateName,
  writeHeaderLine,
} from './header-text.ts'
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
export {
  type CellTokenParse,
  type ParsedFinishMove,
  type ParsedTemplate,
  parseTemplateFile,
  type PlacementCell,
  type PlacementKind,
  SFEN_PIECES,
  stripComments,
  TemplateSyntaxError,
  tryParseCellToken,
} from './parser.ts'
export { PositionOnlyHistory, positionOnlyHistory } from './position-history.ts'
export { priorityOf, sortByPriority, sortByPriorityWithinPly } from './priority.ts'
export {
  type DetectedProverb,
  detectProverbsAtMove,
  KNOWN_PROVERBS,
  type ProverbPattern,
  type ProverbRelation,
  recordProverbs,
} from './proverb.ts'
export {
  AnyOfPieces,
  AnyPiece,
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
  type TemplateRequirement,
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
export {
  type DetectedTechnique,
  detectTechniquesAtMove,
  KNOWN_TECHNIQUES,
  recordTechniques,
  recordTechniquesFirstOccurrence,
  type TechniqueTemplate,
} from './technique.ts'
export type {
  BishopExchange,
  DetectedTemplate,
  DetectedTemplateAt,
  FormationSide,
  FormationTemplate,
  TemplateFinishCapture,
  TemplateFinishMove,
} from './template.ts'
