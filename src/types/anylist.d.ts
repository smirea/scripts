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
    favoriteItems: AnyListShoppingList[];
    client: {
      post(path: string, options: { body: unknown }): Promise<{ statusCode: number }>;
    };
    protobuf: {
      PBListOperation: new () => {
        setMetadata(metadata: { operationId: string; handlerId: string }): void;
        setListId(listId: string): void;
        setList(list: { identifier: string; name: string; items: unknown[] }): void;
      };
      PBListOperationList: new () => {
        setOperations(operations: unknown[]): void;
        toBuffer(): Buffer;
      };
      PBOrderedShoppingListIDsOperation: new () => {
        setMetadata(metadata: { operationId: string; handlerId: string }): void;
        setOrderedListIds(ids: string[]): void;
      };
      PBOrderedShoppingListIDsOperationList: new () => {
        setOperations(operations: unknown[]): void;
        toBuffer(): Buffer;
      };
    };
    constructor(options: AnyListOptions);
    login(connectWebSocket?: boolean): Promise<void>;
    teardown(): void;
    getLists(refreshCache?: boolean): Promise<AnyListShoppingList[]>;
    getListByName(name: string): AnyListShoppingList | undefined;
    getFavoriteItemsByListId(identifier: string): AnyListShoppingList | undefined;
    createItem(item: AnyListItemInput): AnyListItem;
  }
}
