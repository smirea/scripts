#import "QueueBridge.h"

#import <objc/message.h>
#import <objc/runtime.h>

static NSString *WorkoutsQueueUserID;

@interface WorkoutsQueueAuth : NSObject
@end

@implementation WorkoutsQueueAuth

- (NSString *)getUserID {
  return WorkoutsQueueUserID;
}

- (void)getTokenForcingRefresh:(BOOL)forceRefresh
                  withCallback:(void (^)(NSString *_Nullable token, NSError *_Nullable error))callback {
  callback(nil, nil);
}

@end


@interface WorkoutsQueueAuthRegistrant : NSObject
@end


@implementation WorkoutsQueueAuthRegistrant

+ (NSArray *)componentsToRegister {
  Protocol *authProtocol = NSProtocolFromString(@"FIRAuthInterop");
  Class componentClass = NSClassFromString(@"FIRComponent");
  SEL selector = NSSelectorFromString(@"componentWithProtocol:creationBlock:");
  id creationBlock = ^id(id container, BOOL *isCacheable) {
    *isCacheable = YES;
    return [[WorkoutsQueueAuth alloc] init];
  };
  id component = ((id (*)(id, SEL, Protocol *, id))objc_msgSend)(
      componentClass, selector, authProtocol, creationBlock);
  return @[ component ];
}

@end


void WorkoutsQueueRegisterAuth(NSString *userID) {
  WorkoutsQueueUserID = [userID copy];
  Protocol *authProtocol = NSProtocolFromString(@"FIRAuthInterop");
  class_addProtocol(WorkoutsQueueAuth.class, authProtocol);
  Class containerClass = NSClassFromString(@"FIRComponentContainer");
  SEL selector = NSSelectorFromString(@"registerAsComponentRegistrant:");
  ((void (*)(id, SEL, Class))objc_msgSend)(containerClass, selector,
                                           WorkoutsQueueAuthRegistrant.class);
}
