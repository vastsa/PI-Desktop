import type { AppState } from "../app-state";

export type StoreSet = (
  update:
    | Partial<AppState>
    | ((state: AppState) => Partial<AppState>),
) => void;

export type StoreGet = () => AppState;

export type StoreAccess = {
  get: StoreGet;
  set: StoreSet;
};
