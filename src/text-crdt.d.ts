export class OpId {
  readonly counter: number;
  readonly peer: number;
  constructor(counter: number, peer: number);
  compareTo(other: OpId): number;
}

export class TextCrdt {
  constructor(peer: number);
  static fromStr(peer: number, str: string): TextCrdt;
  fork(peer: number): TextCrdt;
  clone(): TextCrdt;
  insert(index: number, ch: string): void;
  insertStr(index: number, str: string): void;
  delete(index: number): void;
  text(): string;
  len(): number;
  is_empty(): boolean;
  tombstoneCount(): number;
  clock(): OpId;
  merge(other: TextCrdt): boolean;
  gcWith(isStable: (deleteOpId: OpId) => boolean): number;
}
