declare module 'anylist' {
  export interface AnyListOptions {
    email: string;
    password: string;
    credentialsFile?: string | null;
  }

  export interface AnyListItemInput {
    name: string;
    quantity?: string;
    details?: string;
    checked?: boolean;
  }

  export interface AnyListItem {
    listId?: string;
    identifier: string;
    name: string;
    quantity?: string;
    details?: string;
    checked?: boolean;
    save(isFavorite?: boolean): Promise<void>;
    toJSON(): {
      listId?: string;
      identifier: string;
      name: string;
      quantity?: string;
      details?: string;
      checked?: boolean;
    };
  }

  export interface AnyListShoppingList {
    identifier: string;
    parentId?: string;
    name: string;
    items: AnyListItem[];
    addItem(item: AnyListItem, isFavorite?: boolean): Promise<AnyListItem>;
    removeItem(item: AnyListItem, isFavorite?: boolean): Promise<void>;
    getItemByName(name: string): AnyListItem | undefined;
  }

  export default class AnyList {
    lists: AnyListShoppingList[];
    constructor(options: AnyListOptions);
    login(connectWebSocket?: boolean): Promise<void>;
    teardown(): void;
    getLists(refreshCache?: boolean): Promise<AnyListShoppingList[]>;
    getListByName(name: string): AnyListShoppingList | undefined;
    createItem(item: AnyListItemInput): AnyListItem;
  }
}
