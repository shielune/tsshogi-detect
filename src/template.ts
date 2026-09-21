/**
 * 囲い・戦法テンプレートの型。
 *
 * 囲いと戦法は「先手視点の升に要件を並べ、後手は 180° 回して照らす」という同じ作りなので、
 * 型は 1 つにしてある。
 */

import type { Color, PieceType } from 'tsshogi'
import type { TemplateRequirement, TemplateSquare } from './requirements.ts'

/** 升の型は要件の語彙なので requirements.ts が持つ。テンプレ側からも引けるようにする。 */
export type { TemplateSquare }

/**
 * 最終手で取った駒の指定 (`finish: ... x <駒>`)。省略すると取っても取らなくても当たる。
 *
 * 駒種は取られた駒の**その時の姿**で見る (と金を取った手は `+P` であって `P` ではない)。
 */
export type TemplateFinishCapture =
  /** 何かを取る手 (`x *`)。駒種は問わない。 */
  | { readonly kind: 'any' }
  /** 何も取らない手 (`x _`)。 */
  | { readonly kind: 'none' }
  /**
   * 挙げた駒のどれかを取る手 (`x R` / `x [BR]`)。最終手は 1 手しか無く、取れる駒も
   * 1 枚なので、並べた駒は OR で読む (AND にすると誰も満たせない)。
   *
   * `negated` を立てると「**それ以外の何かを取る**手」(`x [!BR]`) — 升の `[!GS]` と
   * 違って**取らない手には当たらない**。取らない手は `x _` の側で言う。
   */
  | {
      readonly kind: 'pieces'
      readonly pieces: readonly PieceType[]
      readonly negated: boolean
    }

/**
 * 成立を認める最終手 1 件。`from` を省くと移動元を問わない (着地升だけの指定)。
 * 打った手は移動元を持たないので、`from` のある項目は打ちには当たらない。
 */
export interface TemplateFinishMove {
  readonly from?: TemplateSquare
  readonly to: TemplateSquare
  /**
   * 打った手に限る (`打`)。省略すると打ちも盤上の手も当たる (`from` を書いた項目は
   * 打ちには当たらないので、そちらが「盤上の手に限る」側になる)。
   *
   * 打ちは移動元も成りも取った駒も持たないので、`from` / `promote` / `capture` とは
   * 同時に書けない。
   */
  readonly drop?: boolean
  /** 取った駒の指定。省略すると問わない。 */
  readonly capture?: TemplateFinishCapture
  /** 成った手に限る (`+`)。省略すると成/不成を問わない。 */
  readonly promote?: boolean
}

/**
 * 角交換の要求 (`bishop_exchange:`)。仕掛けた側は**判定する陣営から見て**言う。
 * `self` = 自分から仕掛けた / `opponent` = 相手から仕掛けられた / `any` = どちらでもよい。
 */
export type BishopExchange = 'self' | 'opponent' | 'any'

/** テンプレが居飛車専用 / 振り飛車専用 / 両方かを区別するフラグ。戦法のみ意味を持つ。 */
export type FormationSide = 'either' | 'ibisha' | 'furibisha'

/** 囲い・戦法共通のテンプレート (位置ベースのパターンマッチ)。 */
export interface FormationTemplate {
  readonly name: string
  readonly aliases?: readonly string[]
  /** 親分類 (カニ囲い等)。親自身もテンプレとして存在することがある。 */
  readonly parent?: string
  readonly side?: FormationSide
  /**
   * 盤の形を持たない分類の節 (`category: true`)。単体では成立せず、**子孫のどれかが
   * 成立した陣営で**まとめて成立する (`振り飛車` `居飛車` のような、9x9 の升では
   * 書けない概念)。要件を持たないので照合の対象からは外れる。
   */
  readonly category?: boolean
  /** ちょうどこの手数でのみ成立を認める。 */
  readonly plyEq?: number
  /** 成立手数の下限。これより前の局面では成立を認めない。 */
  readonly plyMin?: number
  /** 成立手数の上限。 */
  readonly plyMax?: number
  /** 最終局面で 1 度だけ評価するテンプレ (居玉)。 */
  readonly evaluateAtGameEnd?: boolean
  /**
   * 同じ手数で複数成立したときに、返す配列の**どこに置くか** (`priority:`)。
   * 大きいほど前に出る。省略は 0 で、後ろへ回したければ負の数も書ける。
   *
   * 成立するかどうかには関わらない。返す件数は変わらず、順番だけが変わる。
   */
  readonly priority?: number
  /**
   * 持駒を打って形を揃えた成立を認めない。要求している升のどれかに、その陣営が
   * 打った駒がそのまま乗っている間は成立させない (`no_drop:`)。
   */
  readonly noDrop?: boolean
  /**
   * 角交換が済んでいることを求める (`bishop_exchange:`)。省略すれば問わない。
   * 誰が仕掛けたかまで縛れる (角換わりと角交換振り飛車は、仕掛けた側が違う)。
   */
  readonly bishopExchange?: BishopExchange
  /**
   * 成立を認める最終手。成立させた手がこのどれかに当たることを求める (`finish:`)。
   * `from` を持たない項目は着地升だけを見る。空・省略なら制限なし。
   */
  readonly finishMoves?: readonly TemplateFinishMove[]
  readonly placements: readonly TemplateRequirement[]
}

export interface DetectedTemplate {
  readonly template: FormationTemplate
  readonly side: Color
}

/** 棋譜の中でテンプレが初めて成立した手。 */
export interface DetectedTemplateAt extends DetectedTemplate {
  readonly ply: number
}
