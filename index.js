var parse = require('./pattern').parse,
    ieee754   = require('./ieee754'),
    util = require('util'),
    __slice = [].slice;

function objectify () {
  var i, I, name;
  for (i = 0, I = arguments.length; i < I; i++) {
    name = arguments[i].name;
    if (name[0] == "_")
      this.__defineGetter__(name.slice(1), arguments[i]);
    else
      this[arguments[i].name] = arguments[i];
  }
  return this;
}

// The default transforms built into Packet.
var transforms =
// Convert the value to and from the given encoding.
{ str: function (encoding, parsing, field, value) {
  var i, I, ascii = /^ascii$/i.test(encoding);
    if (parsing) {
      if (! (value instanceof Buffer)) value = new Buffer(value);
      // Broken and waiting on [297](http://github.com/ry/node/issues/issue/297).
      // If the top bit is set, it is not ASCII, so we zero the value.
      if (ascii) {
        for (i = 0, I = value.length; i < I; i++) {
          if (value[i] & 0x80) value[i] = 0;
        }
        encoding = "utf8"
      }
      var length = value.length;
      return value.toString(encoding, 0, length);
    } else {
      var buffer = new Buffer(value, encoding);
      if (ascii) {
        for (var i = 0, I = buffer.length; i < I; i++) {
          if (value.charAt(i) == '\u0000') buffer[i] = 0;
        }
      }
      return buffer;
    }
  }
// Convert to and from ASCII.
, ascii: function (parsing, field, value) {
    return transforms.str("ascii", parsing, field, value);
  }
// Convert to and from UTF-8.
, utf8: function (parsing, field, value) {
    return transforms.str("utf8", parsing, field, value);
  }
// Add padding to a value before you write it to stream.
, pad: function (character, length, parsing, field, value) {
    if (! parsing) {
      while (value.length < length) value = character + value;
    }
    return value;
  }
// Convert a text value from alphanumeric to integer.
, atoi: function (base, parsing, field, value) {
    return parsing ? parseInt(value, base) : value.toString(base);
  }
// Convert a text value from alphanumeric to float.
, atof: function (parsing, field, value) {
    return parsing ? parseFloat(value) : value.toString();
  }
};

function die () {
  console.log.apply(console, [].slice.call(arguments, 0));
  process.exit(1);
}

function say () { console.log.apply(console, [].slice.call(arguments, 0)) }

// The `Definition` class is contained by the `Serializer` and parser. We expose
// public methods by explicitly adding the methods to the `Serializer` or
// `Parser` when we create them. The `Definition` class references only enclosed
// variables, but it does use prototypical inheritance to extend the collections
// of packet patterns and transforms.

function Definition (context, packets, transforms) {
  packets = Object.create(packets);
  transforms = Object.create(transforms);

  function packet (name, pattern) {
    packets[name] = parse(pattern);
  }

  function transform (name, procedure) {
    transforms[name] = procedure;
  }

  function pattern (nameOrPattern) {
    return packets[nameOrPattern] || parse(nameOrPattern);
  }

  function createParser (context) {
    return new Parser(new Definition(context, packets, transforms));
  }

  function createSerializer (context) {
    return new Serializer(new Definition(context, packets, transforms));
  }

  function extend (object) {
    return objectify.call(object, packet, transform, createParser, createSerializer);
  }

  // Execute the pipeline of transforms for the `pattern` on the `value`.
  function pipeline (outgoing, pattern, value, reverse) {
    var i, I, j, J, by, pipeline, parameters, transform;
    // Run the pipelines for parsing.
    if (pipeline = pattern.pipeline) {
      if (reverse) {
        i = pipeline.length - 1, I = -1, by = -1;
      } else {
        i = 0, I = pipeline.length; by = 1;
      }
      while (i != I) {
        transform = pipeline[i];
        parameters = [];
        for (j = 0, J = transform.parameters.length; j < J; j++) {
          parameters.push(transform.parameters[j])
        }
        parameters.push(outgoing, pattern, value);
        value = transforms[transform.name].apply(null, parameters);
        i += by;
      }
    }
    return value;
  }

  this.context = context;

  return objectify.call(this, packet, transform, pattern, pipeline, extend);
}


//#### Parser

// Construct a `Parser` around the given `definition`.
function Parser (definition) {
  var increment, valueOffset, terminal, terminated, terminator, value,
  bytesRead = 0, skipping, repeat, step, named, index, arrayed,
  pattern, patternIndex, context = definition.context || this, fields, _callback;

  // The length property of the `Parser`, returning the number of bytes read.
  function _length () { return bytesRead }

  // The public `reset` method to reuse the parser, clearing the current state.
  function reset () { bytesRead = 0 }

  // Prepare the parser for the next field in the pattern.
  function nextField ()  {
    var field = pattern[patternIndex];
    repeat = field.repeat;
    index = 0;
    skipping    = null;
    terminated = ! field.terminator;
    terminator = field.terminator && field.terminator[field.terminator.length - 1];
    named = named || !! field.name;
    if (field.arrayed && field.endianness  != "x") arrayed = [];
  }

  // Prepare the parser to parse the next value in the stream. It initializes
  // the value to a zero integer value or an array. This method accounts for
  // skipping, for skipped patterns.
  function nextValue () {
    // Get the next pattern.
    var field = pattern[patternIndex];

    // If skipping, skip over the count of bytes.
    if (field.endianness == "x") {
      skipping  = field.bytes;

    // Otherwise, create the empty value.
    } else {
      value = field.exploded ? [] : 0;
    }
    var little = field.endianness == 'l';
    var bytes = field.bytes;
    terminal = little ? bytes : -1;
    valueOffset = little ? 0 : bytes - 1;
    increment = little ? 1 : -1;
  }

  // Sets the next packet to extract from the stream by providing a packet name
  // defined by the `packet` function or else a packet pattern to parse. The
  // `callback` will be invoked when the packet has been extracted from the
  // buffer or buffers given to `parse`.

  //
  function extract (nameOrPattern, callback) {
    pattern = definition.pattern(nameOrPattern);
    patternIndex = 0;
    _callback = callback;
    fields = [];

    nextField();
    nextValue();
  }

  //#### parser.parse(buffer[, start][, length])
  // The `parse` method reads from the buffer, returning when the current pattern
  // is read, or the end of the buffer is reached.

  // Read from the `buffer` for the given `start` offset and `length`.
  function parse (buffer, start, length) {
    // Initialize the loop counters. Initialize unspecified parameters with their
    // defaults.
    var bufferOffset = start || 0,
        bufferEnd = bufferOffset + (length == null ? buffer.length : length),
        bytes, bits;
    start = bufferOffset;

    // We set the pattern to null when all the fields have been read, so while
    // there is a pattern to fill and bytes to read.
    PATTERN: while (pattern != null && bufferOffset < bufferEnd) {
      field = pattern[patternIndex];
      // If we are skipping, we advance over all the skipped bytes or to the end
      // of the current buffer.
      if (skipping != null) {
        var advance  = Math.min(skipping, bufferEnd - bufferOffset);
        var begin    = bufferOffset;
        bufferOffset       += advance;
        skipping   -= advance;
        bytesRead  += advance;
        // If we have more bytes to skip, then break because we've consumed the
        // entire buffer.
        if (skipping) break;
        else skipping = null
      } else {
        // If the pattern is exploded, the value we're populating is an array.
        if (field.exploded) {
          for (;;) {
            value[valueOffset] = buffer[bufferOffset];
            bufferOffset++;
            valueOffset += increment;
            bytesRead++;
            if (valueOffset == terminal) break;
            if (bufferOffset == bufferEnd) break PATTERN;
          }
        // Otherwise we're packing bytes into an unsigned integer, the most
        // common case.
        } else {
          for (;;) {
            value += Math.pow(256, valueOffset) * buffer[bufferOffset];
            bufferOffset++;
            valueOffset += increment
            bytesRead++;
            if (valueOffset == terminal) break;
            if (bufferOffset == bufferEnd) break PATTERN;
          }
        }
        // Unpack the field value. Perform our basic transformations. That is,
        // convert from a byte array to a JavaScript primitive.
        //
        // Resist the urge to implement these conversions with pipelines. It
        // keeps occurring to you, but those transitions are at a higher level
        // of abstraction, primarily for operations on gathered byte arrays.
        // These transitions need to take place immediately to populate those
        // arrays.

        // By default, value is as it is.
        bytes = value;

        // Convert to float or double.
        if (field.type == "f") {
          if (field.bits == 32)
            value = ieee754.fromIEEE754Single(bytes)
          else
            value = ieee754.fromIEEE754Double(bytes)

        // Get the two's compliment signed value.
        } else if (field.signed) {
          value = 0;
          if ((bytes[bytes.length - 1] & 0x80) == 0x80) {
            var top = bytes.length - 1
            for (i = 0; i < top; i++)
              value += (~bytes[i] & 0xff) * Math.pow(256, i)
            // To get the two's compliment as a positive value you use
            // `~1 & 0xff == 254`. For example: `~1 == -2`.
            value += (~(bytes[top] & 0x7f) & 0xff & 0x7f) * Math.pow(256, top);
            value += 1;
            value *= -1;
          } else {
            // Not really necessary, the bit about top.
            top = bytes.length - 1
            for (i = 0; i < top; i++)
              value += (bytes[i] & 0xff)  * Math.pow(256, i);
            value += (bytes[top] & 0x7f) * Math.pow(256, top);
          }
        }
        // If the current field is arrayed, we keep track of the array we're
        // building after a pause through member variable.
        if (field.arrayed) arrayed.push(value);
      }

      // If we've not yet hit our terminator, check for the terminator. If we've
      // hit the terminator, and we do not have a maximum size to fill, then
      // terminate by setting up the array to terminate.
      //
      // A length value of the maximum number value means to repeat until the
      // terminator, but a specific length value means that the zero terminated
      // string occupies a field that has a fixed length, so we need to skip the
      // unused bytes.
      if (! terminated) {
        if (terminator == value) {
          terminated = true;
          var t = pattern[patternIndex].terminator;
          for (i = 1, I = t.length; i <= I; i++) {
            if (arrayed[arrayed.length - i] != t[t.length - i]) {
              terminated = false
              break
            }
          }
          if (terminated) {
            for (i = 0, I + t.length; i < I; i++) {
              arrayed.pop();
            }
            terminated = true;
            if (repeat == Number.MAX_VALUE) {
              repeat = index + 1;
            } else {
              skipping = (repeat - (++index)) * field.bytes
              if (skipping) {
                repeat = index + 1;
                continue
              }
            }
          }
        }
      }

      // If we are reading an arrayed pattern and we have not read all of the
      // array elements, we repeat the current field type.
      if (++index <  repeat) {
        nextValue();

      // Otherwise, we've got a complete field value, either a JavaScript
      // primitive or raw bytes as an array.
      } else {

        // If we're not skipping, push the field value after running it through
        // the pipeline.
        if (field.endianness != "x") {
          var packing;

          // If the field is a bit packed field, unpack the values and push them
          // onto the field list.
          if (packing = field.packing) {
            var length  = field.bits;
            for (i = 0, I = packing.length; i < I; i++) {
              var pack = packing[i];
              length -= pack.bits;
              if (pack.endianness == "b") {
                var unpacked = Math.floor(value / Math.pow(2, length));
                unpacked = unpacked % Math.pow(2, pack.bits);
                // If signed, we convert from two's compliment.
                if (pack.signed) {
                  var mask = Math.pow(2, pack.bits - 1)
                  if (unpacked & mask)
                    unpacked = -(~(unpacked - 1) & (mask * 2 - 1))
                }
                fields.push(unpacked);
              }
            }

          // If the value is a length encoding, we set the repeat value for the
          // subsequent array of values. If we have a zero length encoding, we
          // push an empty array through the pipeline, and move on to the next
          // field.
          } else if (field.lengthEncoding) {
            if ((pattern[patternIndex + 1].repeat = value) == 0) {
              fields.push(definition.pipeline(true, field, [], false))
              patternIndex++
            }
          // If the value is used as a switch for an alternation, we run through
          // the different possible branches, updating the pattern with the
          // pattern of the first branch that matches. We then re-read the bytes
          // used to determine the conditional outcome.
          } else if (field.alternation) {
            // This makes no sense now.I wonder if it is called.
            // unless field.signed
            //  value = (Math.pow(256, i) * b for b, i in arrayed)
            var i, I, branch;
            for (i = 0, I = field.alternation.length; i < I; i++) {
              branch = field.alternation[i];
              if (branch.read.minimum <= value &&
                  value <= branch.read.maximum &&
                  (value & branch.read.mask) == branch.read.mask)
                break;
            }
            if (branch.failed)
              throw new Error("Cannot match branch.");
            bytes = arrayed.slice(0);
            bytesRead -= bytes.length;
            pattern = pattern.slice(0);
            pattern.splice.apply(pattern, [ patternIndex, 1 ].concat(branch.pattern));
            nextField();
            nextValue();
            parse(bytes, 0, bytes.length);
            continue;


          // Otherwise, the value is what it is, so run it through the user
          // supplied transformation pipeline, and push it onto the list of
          // fields.
          } else {
            if (field.arrayed) value = arrayed;
            fields.push(definition.pipeline(true, field, value, false));
          }
        }
        // If we have read all of the pattern fields, call the associated
        // callback.  We add the parser and the user supplied additional
        // arguments onto the callback arguments.
        //
        // The pattern is set to null, our terminal condition, because the
        // callback may specify a subsequent packet to parse.
        if (++patternIndex == pattern.length) {
          var field = pattern;
          pattern = null;

          if (_callback) {
            // At one point, you thought you could have  a test for the arity of
            // the function, and if it was not `1`, you'd call the callback
            // positionally, regardless of named parameters. Then you realized
            // that the `=>` operator in CoffeeScript would use a bind function
            // with no arguments, and read the argument array. If you do decide to
            // go back to arity override, then greater than one is the trigger.
            // However, on reflection, I don't see that the flexibility is useful,
            // and I do believe that it will generate at least one bug report that
            // will take a lot of hashing out only to close with "oh, no, you hit
            // upon a "hidden feature".
            var number = 1
            if (named) {
              var object = {};
              for (i = 0, I = field.length; i < I; i++) {
                bits = field[i];
                if (bits.endianness != "x") {
                  if (bits.packing) {
                    for (var j = 0, J = bits.packing.length; j < J; j++) {
                      pack = bits.packing[j];
                      if (pack.endianness != "x") {
                        if (pack.name) {
                          object[pack.name] = fields[number - 1]
                        } else {
                          object["field" + number] = fields[number - 1]
                        }
                        number++;
                      }
                    }
                  } else {
                    if (bits.name)
                      object[bits.name] = fields[number - 1];
                    else
                      object["field" + number] = fields[number - 1];
                    number++;
                  }
                }
              }
              _callback.call(context, object);
            } else {
              _callback.apply(context, fields);
            }
          }
        // Otherwise we proceed to the next field in the packet pattern.
        } else {
          nextField();
          nextValue();
        }
      }
    }
    // Return the count of bytes read.
    return bufferOffset - start;
  }

  return objectify.call(definition.extend(this), extract, parse, reset, _length);
}

module.exports.Parser = Parser;

// Construct a `Serializer` around the given `definition`.
function Serializer(definition) {
  var serializer = this, terminal, valueOffset, increment, value, bytesWritten = 0,
  skipping, repeat, outgoing, index, terminated, terminates, pattern,
  patternIndex, context = definition.context || this, padding, _callback;

  function _length () { return bytesWritten }

  function reset () { bytesWritten = 0 }

  // Prepare the parser for the next field in the pattern.
  function nextField () {
    var field  = pattern[patternIndex]
    repeat       = field.repeat;
    terminated  = ! field.terminator;
    terminates  = ! terminated;
    index       = 0;
    padding     = null;

    // Can't I keep separate indexes? Do I need that zero?
    if (field.endianness ==  "x") {
      outgoing.splice(patternIndex, 0, null);
      if (field.padding != null)
        padding = field.padding
    }
  }

  // Prepare the parser to serialize the next value to the stream. It
  // initializes Initialize the next field value to serialize. In the case of an
  // arrayed value, we will use the next value in the array. This method will
  // adjust the pattern for alteration. It will pack a bit packed integer. It
  // will covert the field to a byte array for floats and signed negative
  // numbers.
  function nextValue () {
    var i, I, packing, count, length, pack, unpacked, range, mask;
    var field = pattern[patternIndex];

    // If we are skipping without filling we note the count of bytes to skip,
    // otherwise we prepare our value.
    if (field.endianness ==  "x" &&  padding == null) {
      skipping = field.bytes
    } else {
      // If we're filling, we write the fill value.
      if (padding != null) {
        value = padding;

      // If the field is arrayed, we get the next value in the array.
      } else if (field.arrayed) {
        value = outgoing[patternIndex][index];

      // If the field is bit packed, we update the `outgoing` array of values
      // by packing zero, one or more values into a single value. We will also
      // check for bits filled with a pattern specified filler value and pack
      // that in there as well.
      } else if (packing = field.packing) {
        count = 0, value = 0, length = field.bits;
        for (i = 0, I = packing.length; i < I; i++) {
          pack = packing[i];
          length -= pack.bits;
          if (pack.endianness ==  "b" || pack.padding != null) {
            unpacked = pack.padding != null ? pack.padding : outgoing[patternIndex + count++]
            if (pack.signed) {
              range = Math.pow(2, pack.bits - 1)
              if (!( (-range) <= unpacked &&  unpacked <= range - 1))
                throw new Error("value " + unpacked + " will not fit in " + pack.bits + " bits");
              if (unpacked < 0) {
                mask = range * 2 - 1
                unpacked = (~(- unpacked) + 1) & mask
              }
            }
            value += unpacked * Math.pow(2, length)
          }
        }
        outgoing.splice(patternIndex, count, value);

      // If the current field is a length encoded array, then the length of the
      // current array value is the next value, otherwise, we have the simple
      // case, the value is the current value.
      } else {
        if (field.lengthEncoding) {
          var repeat = outgoing[patternIndex].length;
          outgoing.splice(patternIndex, 0, repeat);
          pattern[patternIndex + 1].repeat = repeat;
        }
        value = outgoing[patternIndex];
      }
      // If the array is not an unsigned integer, we might have to convert it.
      if (field.exploded) {
        // Convert a float into its IEEE 754 representation.
        if (field.type == "f") {
          if (field.bits == 32)
            value = ieee754.toIEEE754Single(value)
          else
            value = ieee754.toIEEE754Double(value)

        // Convert a signed integer into its two's compliment representation.
        } else if (field.signed) {
          var copy = Math.abs(value);
          var bytes = [];
          // FIXME If the value is greater than zero, we can just change the
          // pattern to packed.
          for (i = 0, I = field.bytes; i < I; i++) {
            var pow = Math.pow(256, i)
            bytes[i] = Math.floor(copy / pow % (pow * 256))
          }
          if (value < 0) {
            var carry = 1;
            for (i = 0, I = bytes.length; i < I; i++) {
              bytes[i] = (~bytes[i] & 0xff) + carry;
              if (bytes[i] ==  256) bytes[i] = 0;
              else carry = 0;
            }
          }
          value = bytes;
        }
      }
      var little = field.endianness == 'l';
      var bytes = field.bytes;
      terminal = little  ? bytes : -1;
      valueOffset = little ? 0 : bytes - 1;
      increment = little ? 1 : -1;
    }
  }

  function serialize () {
    var shiftable = __slice.call(arguments),
        alternates = definition.pattern(shiftable.shift()).slice(0),
        callback = typeof shiftable[shiftable.length - 1] == 'function' ? shiftable.pop() : void(0),
        named = (shiftable.length ==  1
                 && typeof shiftable[0] ==  "object"
                 && ! (shiftable[0] instanceof Array)),
        incoming = named ? shiftable.shift() : shiftable,
        skip = 0,
        field, value, alternate, i, I, j, J, k, K;

    _callback = callback;
    patternIndex = 0;

    outgoing = [], pattern = [];

    // Determine alternation now, creating a pattern with the alternation
    // resolved.

    for (i = 0; i < alternates.length; i++) {
      field = alternates[i];
      // The name of value to test for alternation is either the first name in
      // the alternation or else if the first value is bit packed, the first
      // name in the packed alternates.
      if (field.alternation) {
        field = field.alternation[0];
        if (field.pattern[0].packing) {
          field = field.pattern[0].packing[0];
        }
        value = named ? incoming[field.name] : incoming[0];

        field = alternates[i];
        for (j = 0, J = field.alternation.length; j < J; j++) {
          alternate = field.alternation[j];
          if (alternate.write.minimum <= value &&  value <= alternate.write.maximum) {
            break;
          }
        }

        alternates.splice.apply(alternates, [ i--, 1 ].concat(alternate.pattern));
        continue;
      }

      pattern.push(field);

      if (field.packing) {
        for (j = 0, J = field.packing.length; j < J; j++) {
          if (field.packing[j].endianness != 'x') {
            outgoing.push(named ? incoming[field.packing[j].name] : incoming.shift());
          }
        }
      } else {
        if (field.endianness != 'x') {
          outgoing.push(named ? incoming[field.name] : incoming.shift());
        }
      }
    }

    // Run the outgoing values through field pipelines before we enter the write
    // loop. We need to skip over the blank fields and constants. We also skip
    // over bit packed fields because we do not apply pipelines to packed fields.
    for (j = 0, i = 0, I = outgoing.length; i < I; i++) {
      value = outgoing[i];
      if (skip) {
        skip--
        continue
      }
      if (pattern[j].packing) {
        for (k = 0, K = pattern[j].packing.length; k < K; k++) {
          if (pattern[j].packing[k].endianness ==  "b") skip++;
        }
        if (skip > 0) skip--;
      } else {
        while (pattern[j] &&  pattern[j].endianness ==  "x") j++;
        if (! pattern[j]) throw new Error("too many fields");
        outgoing[i] = definition.pipeline(! outgoing, pattern[j], value, true)
      }
      j++;
    }

    nextField();
    nextValue();
  }

  // Return the count of bytes that will be written by the serializer for the
  // current pattern and variables.
  function _sizeOf () {
    var patternIndex = 0, field = pattern[patternIndex], repeat = field.repeat,
        outgoingIndex = 0, size = 0;
    while (field) {
      if (field.terminator) {
        repeat = outgoing[outgoingIndex++].length + field.terminator.length;
        if (field.repeat != Number.MAX_VALUE) {
          repeat = field.repeat;
        }
      } else {
        repeat = field.repeat || 1;
        outgoingIndex += repeat;
      }
      size += field.bytes * repeat;
      field = pattern[++patternIndex];
    }
    return size;
  }

  //#### serializer.write(buffer[, start][, length])

  // The `write` method writes to the buffer, returning when the current pattern
  // is written, or the end of the buffer is reached.  Write to the `buffer` in
  // the region defined by the given `start` offset and `length`.
  function write (buffer, start, length) {
    // **TODO**: Tidy.
    var bufferOffset = start || 0;
    if (length == null) length = buffer.length;
    var bufferEnd = bufferOffset + (length == null ? buffer.length : length);
    start = bufferOffset;

    // While there is a pattern to fill and space to write.
    PATTERN: while (pattern.length != patternIndex &&  bufferOffset < bufferEnd) {
      if (skipping) {
        var advance     = Math.min(skipping, bufferEnd - bufferOffset);
        bufferOffset         += advance;
        skipping      -= advance;
        bytesWritten  += advance;
        if (skipping) break;

      } else {
        // If the pattern is exploded, the value we're writing is an array.
        if (pattern[patternIndex].exploded) {
          for (;;) {
            buffer[bufferOffset] = value[valueOffset];
            valueOffset += increment;
            bytesWritten++;
            bufferOffset++;
            if (valueOffset ==  terminal) break;
            if (bufferOffset == bufferEnd) break PATTERN;
          }
        // Otherwise we're unpacking bytes of an unsigned integer, the most common
        // case.
        } else {
          for (;;) {
            buffer[bufferOffset] = Math.floor(value / Math.pow(256, valueOffset)) & 0xff;
            valueOffset += increment;
            bytesWritten++;
            bufferOffset++;
            if (valueOffset ==  terminal) break;
            if (bufferOffset ==  bufferEnd) break PATTERN;
          }
        }
      }
      // If we have not terminated, check for the termination state change.
      // Termination will change the loop settings.
      if (terminates) {
        if (terminated) {
          if (repeat ==  Number.MAX_VALUE) {
            repeat = index + 1
          } else if (pattern[patternIndex].padding != null)  {
            padding = pattern[patternIndex].padding
          } else {
            skipping = (repeat - (++index)) * pattern[patternIndex].bytes;
            if (skipping) {
              repeat = index + 1;
              continue;
            }
          }
        } else {
          // If we are at the end of the series, then we create an empty outgoing
          // array to hold the terminator, because the outgoing series may be a
          // buffer. We insert the terminator at next index in the outgoing array.
          // We then set repeat to allow one more iteration before callback.
          if (outgoing[patternIndex].length == index + 1) {
            terminated = true;
            outgoing[patternIndex] = [];
            var terminator = pattern[patternIndex].terminator;
            for (var i = 0, I = terminator.length; i < I; i++) {
              outgoing[patternIndex][index + 1 + i] = terminator[i];
            }
          }
        }
      }
      // If we are reading an arrayed pattern and we have not read all of the
      // array elements, we repeat the current field type.
      if (++index < repeat) {
        nextValue();

      // If we have written all of the packet fields, call the associated
      // callback with self parser.
      //
      // The pattern is set to null, our terminal condition, before the callback,
      // because the callback may specify a subsequent packet to parse.
      } else if (++patternIndex ==  pattern.length) {
        if (_callback != null) {
          _callback.call(context, serializer);
        }
      } else {

        padding = null;
        repeat      = pattern[patternIndex].repeat;
        terminated  = ! pattern[patternIndex].terminator;
        terminates  = ! terminated;
        index       = 0;

        nextField();
        nextValue();
      }
    }

    return bufferOffset - start;
  }

  objectify.call(definition.extend(this), serialize, write, reset, _length, _sizeOf);
}

function createParser (context) { return new Parser(new Definition(context, {}, transforms)) }
function createSerializer (context) { return new Serializer(new Definition(context, {}, transforms)) }

objectify.call(exports, createParser, createSerializer);
