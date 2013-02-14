
    var SharedBuffer = (function () {
        inherits(Enumerable, SharedBuffer);

        function SharedBuffer (source) {
            this.disposed = false;
            this.source = source;
        }

        SharedBuffer.prototype.getEnumerator = function () {
            var e, current, self = this;
            return enumeratorCreate(
                function () {
                    e && (e = self.source.getEnumerator());

                    if (e.moveNext()) {
                        current = e.getCurrent();
                        return true;
                    }
                    return false;
                },
                function () { return current; }, 
                function () { e && e.dispose(); });
        };

        SharedBuffer.prototype.dispose = function () {
            if (!this.disposed) {
                this.disposed = true;
                this.source = null;
            }
        };

        return SharedBuffer;
    }());

    /**
     * Shares the source sequence within a selector function where each enumerator can fetch the next element from the source sequence.
     * 
     * var rng = Enumerable.range(0, 10).share();
     * 
     * var e1 = rng.getEnumerator();    // Both e1 and e2 will consume elements from
     * var e2 = rng.getEnumerator();    // the source sequence.
     * 
     * ok(e1.moveNext());
     * equal(0, e1.getCurrent());
     * 
     * ok(e1.moveNext());
     * equal(1, e1.getCurrent());
     * 
     * ok(e2.moveNext());    // e2 "steals" element 2
     * equal(2, e2.getCurrent());
     * 
     * ok(e1.moveNext());    // e1 can't see element 2
     * equal(3, e1.getCurrent());
     * 
     * @param {Function} [selector] Selector function with shared access to the source sequence for each enumerator.
     * @return Sequence resulting from applying the selector function to the shared view over the source sequence.
     */
    EnumerablePrototype.share = function (selector) {
        return !selector ? 
            new SharedBuffer(source.getEnumerator()) :
            new Enumerable(function () { return selector(source.share()).getEnumerator(); });
    };

    function RefCountList(readerCount) {
        this.readerCount = readerCount;
        this.list = {};
        this.length = 0;
    }

    var RefCountListPrototype = RefCountList.prototype;
    RefCountListPrototype.clear = function () {
        this.list = {};
        this.length = 0;
    };

    RefCountListPrototype.get = function (i) {
        if (!this.list[i]) {
            throw new Error('Element no longer available in the buffer.');
        }
        var res = this.list[i];
        if (--res.length === 0) { delete this.list[i]; }
        return res.value;
    };

    RefCountListPrototype.push = function (item) {
        this.list[this.length++] = { value: item, length: this.readerCount };
        this.length++;
    };

    RefCountListPrototype.done = function () {
        this.readerCount--;
    };

    var PublishedBuffer = (function () {
        inherits(PublishedBuffer, Enumerable);

        function PublishedBuffer(source) {
            this.source = source;
            this.buffer = new RefCountList(0);
            this.disposed = false;
            this.stopped = false;
            this.error = null;
        }

        function getEnumerator(i) {
            var currentValue, e, self = this, isDisposed = false, isFirst = true;
            return enumeratorCreate(
                function () {
                    e || (e = self.source.getEnumerator());

                    if (self.disposed) { throw new Error('Object disposed'); }
                    if (!isFirst) { i++; }
                    var hasCurrent = false, current;
                    if (i <= self.buffer.length) {
                        if (!self.stopped) {
                            try {
                                hasNext = self.source.moveNext();
                                if (hasValue) { current = self.source.getCurrent(); }

                            } catch (e) {
                                self.stopped = true;
                                self.error = e;
                                self.source.dispose();
                                isDisposed = true;
                            }
                        }

                        if (self.stopped) {
                            if (self.error) {
                                throw self.error;
                            } else {
                                return false;
                            }
                        }

                        if (hasValue) {
                            self.buffer.push(current);
                        }
                    } else {
                        hasValue = true;
                    }

                    if (hasValue) {
                        currentValue = self.buffer[i];
                        isFirst = false;
                        return true;
                    } else {
                        return false;
                    }
                }, 
                function () { return currentValue; }, 
                function () {
                    self.buffer && self.buffer.done(i);
                    e && isDisposed && e.dispose();
                });
        }

        PublishedBuffer.prototype.getEnumerator = function () {
            var i = this.buffer.length;
            this.buffer.length++;
            return getEnumerator.call(this, i);
        };

        PublishedBuffer.prototype.dispose = function () {
            if (!this.disposed) {
                this.source.dispose();
                this.source = null;
                this.buffer.clear();
                this.buffer = null;
                this.disposed = true;
            }
        };

        return PublishedBuffer;
    }());

    /**
     * Publishes the source sequence within a selector function where each enumerator can obtain a view over a tail of the source sequence.
     *
     * var rng = Enumerable.Range(0, 10).Publish();
     * 
     * var e1 = rng.getEnumerator();    // e1 has a view on the source starting from element 0
     * 
     * ok(e1.moveNext());
     * equal(0, e1.getCurrent());
     * 
     * ok(e1.moveNext());
     * equal(1, e1.getCurrent());
     * 
     * var e2 = rng.getEnumerator();
     * 
     * ok(e2.moveNext());    // e2 has a view on the source starting from element 2
     * equal(2, e2.getCurrent());
     * 
     * ok(e1.moveNext());    // e1 continues to enumerate over its view
     * equal(2, e1.getCurrent());
     * 
     * @param selector Selector function with published access to the source sequence for each enumerator.
     * @return Sequence resulting from applying the selector function to the published view over the source sequence.
     */
    EnumerablePrototype.publish = function (selector) {
        return !selector ? 
            new PublishedBuffer(source.getEnumerator()) :
            new Enumerable(function () { return selector(source.publish()).getEnumerator(); });
    };

    function MaxRefCountList() {
        this.list = [];
        this.length = 0;
    }

    var MaxRefCountListPrototype = MaxRefCountList.prototype;
    MaxRefCountListPrototype.done = noop;
    MaxRefCountListPrototype.push = function (item) {
        this.list[this.length++] = item;
    };

    MaxRefCountListPrototype.clear = function () {
        this.list = [];
        this.length = 0;
    };

    MaxRefCountListPrototype.get = function (i) { 
        return this.list[i]; 
    };

    var MemoizedBuffer = (function () {
        inherits(MemoizedBuffer, Enumerable);

        function MemoizedBuffer(source, buffer) {
            this.source = source;
            this.buffer = buffer
            this.stopped = false;
            this.error = null;
            this.disposed = false;
        }

        MemoizedBuffer.prototype.getEnumerator = function () {
            var currentValue, e, self = this, isDisposed = false, isFirst = true, i = 0;
            return enumeratorCreate(
                function () {
                    e || (e = self.source.getEnumerator());

                    if (self.disposed) { throw new Error('Object disposed'); }
                    if (!isFirst) { i++; }
                    var hasCurrent = false, current;
                    if (i <= self.buffer.length) {
                        if (!self.stopped) {
                            try {
                                hasNext = self.source.moveNext();
                                if (hasValue) { current = self.source.getCurrent(); }

                            } catch (e) {
                                self.stopped = true;
                                self.error = e;
                                self.source.dispose();
                                isDisposed = true;
                            }
                        }

                        if (self.stopped) {
                            if (self.error) {
                                throw self.error;
                            } else {
                                return false;
                            }
                        }

                        if (hasValue) {
                            self.buffer.push(current);
                        }
                    } else {
                        hasValue = true;
                    }

                    if (hasValue) {
                        currentValue = self.buffer[i];
                        isFirst = false;
                        return true;
                    } else {
                        return false;
                    }
                }, 
                function () { return currentValue; }, 
                function () {
                    self.buffer && self.buffer.done(i);
                    e && isDisposed && e.dispose();
                });
        };

        MemoizedBuffer.prototype.dispose = function () {
            if (!this.disposed) {
                this.source.dispose();
                this.source = null;
                this.buffer.clear();
                this.buffer = null;
                this.disposed = true;
            }
        };
    }());

    /**
     * Memoizes the source sequence within a selector function where a specified number of enumerators can get access to all of the sequence's elements without causing multiple enumerations over the source.
     *
     * var rng = Enumerable.range(0, 10).doAction(function (x) { console.log(x); }).memoize();
     * 
     * var e1 = rng.getEnumerator();
     * 
     * ok(e1.moveNext());    // Prints 0
     * equal(0, e1.getCurrent());
     * 
     * ok(e1.moveNext());    // Prints 1
     * equal(1, e1.getCurrent());
     * 
     * var e2 = rng.getEnumerator();
     * 
     * ok(e2.moveNext());    // Doesn't print anything; the side-effect of Do
     * equal(0, e2.getCurrent());  // has already taken place during e1's iteration.
     * 
     * ok(e1.moveNext());    // Prints 2
     * equal(2, e1.getCurrent());
     *
     * @param readerCount Number of enumerators that can access the underlying buffer. Once every enumerator has obtained an element from the buffer, the element is removed from the buffer.
     * @param selector Selector function with memoized access to the source sequence for a specified number of enumerators.
     * @return Sequence resulting from applying the selector function to the memoized view over the source sequence.
     */
    EnumerablePrototype.memoize = function () {
        var source = this;
        if (arguments.length === 0) {
            return new MemoizedBuffer(source.getEnumerator(), new MaxRefCountList());
        } else if (arguments.length === 1 && typeof arguments[1] === 'function') {
            return new Enumerable(function () { return arguments[1](source.memoize()).getEnumerator(); });
        } else if (arguments.length === 1 && typeof arguments[1] === 'number') {
            return new MemoizedBuffer(source.getEnumerator(), new RefCountList(arguments[1]));
        } else {
            return new Enumerable(function () { return arguments[2](source.memoize(arguments[1])).getEnumerator(); });
        }
    };
