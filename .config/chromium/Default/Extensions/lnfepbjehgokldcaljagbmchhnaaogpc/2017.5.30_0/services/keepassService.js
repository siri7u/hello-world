/*! CKP - KeePass integration for Chrome™, Copyright 2017 Steven Campbell
*/
/**

The MIT License (MIT)

Copyright (c) 2015 Steven Campbell.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

 */

"use strict";

/**
 * Service for opening keepass files
 */
function Keepass(keepassHeader, pako, settings, passwordFileStoreRegistry, keepassReference, streamCipher) {
  var my = {

  };

  var littleEndian = (function() {
    var buffer = new ArrayBuffer(2);
    new DataView(buffer).setInt16(0, 256, true);
    return new Int16Array(buffer)[0] === 256;
  })();

  function getKey(isKdbx, masterPassword, fileKey) {
    var partPromises = [];
    var SHA = {
      name: "SHA-256"
    };

    if (masterPassword || !fileKey) {
      var encoder = new TextEncoder();
      var masterKey = encoder.encode(masterPassword);

      var p = window.crypto.subtle.digest(SHA, new Uint8Array(masterKey));
      partPromises.push(p);
    }

    if (fileKey) {
      partPromises.push(Promise.resolve(fileKey));
    }

    return Promise.all(partPromises).then(function(parts) {
      if (isKdbx || partPromises.length > 1) {
        //kdbx, or kdb with fileKey + masterPassword, do the SHA a second time
        var compositeKeySource = new Uint8Array(32 * parts.length);
        for (var i = 0; i < parts.length; i++) {
          compositeKeySource.set(new Uint8Array(parts[i]), i * 32);
        }

        return window.crypto.subtle.digest(SHA, compositeKeySource);
      } else {
        //kdb with just only fileKey or masterPassword (don't do a second SHA digest in this scenario)
        return partPromises[0];
      }
    });
  }

  my.getMasterKey = function(masterPassword, keyFileInfo) {
    var fileKey = keyFileInfo ? Base64.decode(keyFileInfo.encodedKey) : null;
    return passwordFileStoreRegistry.getChosenDatabaseFile(settings).then(function(buf) {
      var h = keepassHeader.readHeader(buf);
  		return getKey(h.kdbx, masterPassword, fileKey);
  	});
  }

  my.getPasswords = function(masterKey) {
    return passwordFileStoreRegistry.getChosenDatabaseFile(settings).then(function(buf) {
      var h = keepassHeader.readHeader(buf);
      if (!h) throw new Error('Failed to read file header');
      if (h.innerRandomStreamId != 2 && h.innerRandomStreamId != 0) throw new Error('Invalid Stream Key - Salsa20 is supported by this implementation, Arc4 and others not implemented.')

      var encData = new Uint8Array(buf, h.dataStart);
      //console.log("read file header ok.  encrypted data starts at byte " + h.dataStart);
      var SHA = {
        name: "SHA-256"
      };
      var AES = {
        name: "AES-CBC",
        iv: h.iv
      };

      return aes_ecb_encrypt(h.transformSeed, masterKey, h.keyRounds).then(function(finalVal) {
        //do a final SHA-256 on the transformed key
        return window.crypto.subtle.digest({
          name: "SHA-256"
        }, finalVal);
      }).then(function(encMasterKey) {
        var finalKeySource = new Uint8Array(h.masterSeed.byteLength + 32);
        finalKeySource.set(h.masterSeed);
        finalKeySource.set(new Uint8Array(encMasterKey), h.masterSeed.byteLength);

        return window.crypto.subtle.digest(SHA, finalKeySource);
      }).then(function(finalKeyBeforeImport) {
        return window.crypto.subtle.importKey("raw", finalKeyBeforeImport, AES, false, ["decrypt"]);
      }).then(function(finalKey) {
        return window.crypto.subtle.decrypt(AES, finalKey, encData);
      }).then(function(decryptedData) {
        //at this point we probably have successfully decrypted data, just need to double-check:
        if (h.kdbx) {
          //kdbx
          var storedStartBytes = new Uint8Array(decryptedData, 0, 32);
          for (var i = 0; i < 32; i++) {
            if (storedStartBytes[i] != h.streamStartBytes[i]) {
              throw new Error('Decryption succeeded but payload corrupt');
              return;
            }
          }

          //ok, data decrypted, lets start parsing:
          var done = false, pos = 32;
          var blockArray = [], totalDataLength = 0;
          while (!done) {
	          var blockHeader = new DataView(decryptedData, pos, 40);
	          var blockId = blockHeader.getUint32(0, littleEndian);
	          var blockSize = blockHeader.getUint32(36, littleEndian);
	          var blockHash = new Uint8Array(decryptedData, pos+4, 32);

	          if (blockSize > 0) {
		          var block = new Uint8Array(decryptedData, pos+40, blockSize);

		          blockArray.push(block);
		          totalDataLength += blockSize;
		          pos += blockSize + 40;
	          } else {
	          	//final block is a zero block
	          	done = true;
	          }
          }

          var allBlocks = new Uint8Array(totalDataLength);
          pos = 0;
          for (var i=0; i<blockArray.length; i++) {
          	allBlocks.set(blockArray[i], pos);
          	pos += blockArray[i].byteLength;
          }

          if (h.compressionFlags == 1) {
            allBlocks = pako.inflate(allBlocks);
          }
          var decoder = new TextDecoder();
	        var xml = decoder.decode(allBlocks);
          var entries = parseXml(xml, h.protectedStreamKey);
          return entries;

        } else {
          //kdb
          var entries = parseKdb(decryptedData, h);
          return entries;
        }
      }).then(function(entries) {
      	//process references
      	entries.forEach(function(entry) {
      		if (entry.keys) {
	      		entry.keys.forEach(function(key) {
	      			var fieldRefs = keepassReference.hasReferences(entry[key]);
	      			if (fieldRefs) {
	      				entry[key] = keepassReference.processAllReferences(entry[key], entry, entries)
	      			}
	      		});
      		}
      	})

      	return entries;
      });
    });
  }

  //parse kdb file:
  function parseKdb(buf, h) {

    return window.crypto.subtle.digest({
      name: "SHA-256"
    }, h.protectedStreamKey).then(function(streamKey) {
    	streamCipher.setKey(streamKey);

      var pos = 0;
      var dv = new DataView(buf);
      var groups = [];
      for(var i=0; i<h.numberOfGroups; i++) {
        var fieldType = 0, fieldSize = 0;
        var currentGroup = {};
        var preventInfinite = 100;
        while (fieldType != 0xFFFF && preventInfinite > 0) {
          fieldType = dv.getUint16(pos, littleEndian);
          fieldSize = dv.getUint32(pos + 2, littleEndian);
          pos += 6;

          readGroupField(fieldType, fieldSize, buf, pos, currentGroup);
          pos += fieldSize;
          preventInfinite -= 1;
        }

        groups.push(currentGroup);
      }

      var entries = [];
      for(var i=0; i<h.numberOfEntries; i++) {
        var fieldType = 0, fieldSize = 0;
        var currentEntry = {keys: []};
        var preventInfinite = 100;
        while (fieldType != 0xFFFF && preventInfinite > 0) {
          fieldType = dv.getUint16(pos, littleEndian);
          fieldSize = dv.getUint32(pos + 2, littleEndian);
          pos += 6;

          readEntryField(fieldType, fieldSize, buf, pos, currentEntry);
          pos += fieldSize;
          preventInfinite -= 1;
        }

        currentEntry.group = groups.filter(function(grp) {
          return grp.id == currentEntry.groupId;
        })[0];
        currentEntry.groupName = currentEntry.group.name;
        currentEntry.keys.push('groupName');
        currentEntry.groupIconId = currentEntry.group.iconId;

        //in-memory-protect the password in the same way as on KDBX
        if (currentEntry.password) {
        	var position = streamCipher.position;
          var encPassword = streamCipher.encryptString(currentEntry.password);
          currentEntry.protectedData = {
            password: {
              data: encPassword,
              position: position
            }
          };
          currentEntry.password = Base64.encode(encPassword);  //overwrite the unencrypted password
        }

        if (!(currentEntry.title == 'Meta-Info' && currentEntry.userName == 'SYSTEM')
        	&& (currentEntry.groupName != 'Backup')
        	&& (currentEntry.groupName != 'Search Results')) {

          entries.push(currentEntry);
        }
      }

      return entries;
    });
  }

  //read KDB entry field
  function readEntryField(fieldType, fieldSize, buf, pos, entry) {
    var dv = new DataView(buf, pos, fieldSize);
    var arr = [];
    if (fieldSize > 0) {
      arr = new Uint8Array(buf, pos, fieldSize - 1);
    }
    var decoder = new TextDecoder();

    // Expiration not supported.  Mark all entries as unexpired.
    entry.keys.push('expiry');
    entry.expiry = "";
    entry.is_expired = false;

    switch (fieldType) {
      case 0x0000:
        // Ignore field
        break;
      case 0x0001:
        entry.id = convertArrayToUUID(new Uint8Array(buf, pos, fieldSize));
        break;
      case 0x0002:
        entry.groupId = dv.getUint32(0, littleEndian);
        break;
      case 0x0003:
        entry.iconId = dv.getUint32(0, littleEndian);
        break;
      case 0x0004:
        entry.title = decoder.decode(arr);
        entry.keys.push('title');
        break;
      case 0x0005:
        entry.url = decoder.decode(arr);
        entry.keys.push('url');
        break;
      case 0x0006:
        entry.userName = decoder.decode(arr);
        entry.keys.push('userName');
        break;
      case 0x0007:
        entry.password = decoder.decode(arr);
        break;
      case 0x0008:
        entry.notes = decoder.decode(arr);
        entry.keys.push('notes');
        break;
/*
      case 0x0009:
        ent.tCreation = new PwDate(buf, offset);
        break;
      case 0x000A:
        ent.tLastMod = new PwDate(buf, offset);
        break;
      case 0x000B:
        ent.tLastAccess = new PwDate(buf, offset);
        break;
      case 0x000C:
        ent.tExpire = new PwDate(buf, offset);
        break;
      case 0x000D:
        ent.binaryDesc = Types.readCString(buf, offset);
        break;
      case 0x000E:
        ent.setBinaryData(buf, offset, fieldSize);
        break;
*/
    }
  }

  //read KDB group field
  function readGroupField(fieldType, fieldSize, buf, pos, group) {
    var dv = new DataView(buf, pos, fieldSize);
    var arr = [];
		if (fieldSize > 0) {
      arr = new Uint8Array(buf, pos, fieldSize - 1);
    }
    
    switch (fieldType) {
      case 0x0000:
        // Ignore field
        break;
      case 0x0001:
        group.id = dv.getUint32(0, littleEndian);
        break;
      case 0x0002:
        var decoder = new TextDecoder();
        group.name = decoder.decode(arr);
        break;
      case 0x0007:
        group.iconId = dv.getUint32(0, littleEndian);
        break;
      /*
      case 0x0009:
      	group.flags = dv.getUint32(0, littleEndian);
      	break; 
      */
      /*
      case 0x0003:
        group.tCreation = new PwDate(buf, offset);
        break;
      case 0x0004:
        group.tLastMod = new PwDate(buf, offset);
        break;
      case 0x0005:
        group.tLastAccess = new PwDate(buf, offset);
        break;
      case 0x0006:
        group.tExpire = new PwDate(buf, offset);
        break;
      case 0x0007:
        group.icon = db.iconFactory.getIcon(LEDataInputStream.readInt(buf, offset));
        break;
      case 0x0008:
        group.level = LEDataInputStream.readUShort(buf, offset);
        break;
      case 0x0009:
        group.flags = LEDataInputStream.readInt(buf, offset);
        break;
      */
    }
  }

  /**
   * Parses the KDBX entries xml into an object format
   **/
  function parseXml(xml, protectedStreamKey) {
    return window.crypto.subtle.digest({
      name: "SHA-256"
    }, protectedStreamKey).then(function(streamKey) {
    	streamCipher.setKey(streamKey);
      var decoder = new TextDecoder();
      var parser = new DOMParser();
      var doc = parser.parseFromString(xml, "text/xml");
      // console.log(doc);

      var results = [];
      var entryNodes = doc.evaluate('//Entry', doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      var protectedPosition = 0;
      for (var i = 0; i < entryNodes.snapshotLength; i++) {
        var entryNode = entryNodes.snapshotItem(i);
        //console.log(entryNode);
        var entry = {
          protectedData: {},
          keys: []
        };

        //exclude histories and recycle bin:
        if (entryNode.parentNode.nodeName != "History") {
        	entry.searchable = true;
          for (var m = 0; m < entryNode.parentNode.children.length; m++) {
            var groupNode = entryNode.parentNode.children[m];
            if (groupNode.nodeName == 'Name') {
              entry.groupName = groupNode.textContent;
              entry.keys.push('groupName')
            } else if (groupNode.nodeName == 'IconID') {
              entry.groupIconId = Number(groupNode.textContent);
            } else if (groupNode.nodeName == 'EnableSearching' && groupNode.textContent == 'false') {
            	// this group is not searchable
            	entry.searchable = false;
            }
          }

          if (entry.searchable)
            results.push(entry);
        }
        for (var j = 0; j < entryNode.children.length; j++) {
          var childNode = entryNode.children[j];

          if (childNode.nodeName == "UUID") {
          	entry.id = convertArrayToUUID(Base64.decode(childNode.textContent));  
          } else if (childNode.nodeName == "IconID") {
          	entry.iconId = Number(childNode.textContent);  //integer
          } else if (childNode.nodeName == "Tags" && childNode.textContent) {
          	entry.tags = childNode.textContent;
          	entry.keys.push('tags');
          } else if (childNode.nodeName == "Binary") {
          	entry.binaryFiles = childNode.textContent;
          	entry.keys.push('binaryFiles');  //the actual files are stored elsewhere in the xml, not sure where
          } else if (childNode.nodeName == "Times") { // Check if the node expires.
            entry.keys.push('expiry');
            var can_expire = childNode.getElementsByTagName('Expires')[0].textContent;
            if (can_expire == "True"){
              var expiry_text = childNode.getElementsByTagName('ExpiryTime')[0].textContent;
              var expiry_date = Date.parse(expiry_text);
              entry.expiry = expiry_text;
              entry.is_expired = (Date.now() - expiry_date) > 0  // Both measured in milliseconds
            } else {
              entry.expiry = ""; // never expires.
              entry.is_expired = false;
            }
          } else if (childNode.nodeName == "String") {
            var key = childNode.getElementsByTagName('Key')[0].textContent;
            key = Case.camel(key);
            if (key == "keys") {
            	//avoid name conflict when key == "keys"
            	key = "keysAlias";
            }
            var valNode = childNode.getElementsByTagName('Value')[0];
            var val = valNode.textContent;
            var protectedVal = valNode.hasAttribute('Protected');

            if (protectedVal) {
              var encBytes = new Uint8Array(Base64.decode(val));
              entry.protectedData[key] = {
                position: protectedPosition,
                data: encBytes
              };

              protectedPosition += encBytes.length;
            } else {
            	entry.keys.push(key);
            }
            entry[key] = val;
          }
        }
      }

      //console.log(results);
      return results;
    });
  }

  function aes_ecb_encrypt(rawKey, data, rounds) {
    var data = new Uint8Array(data);
    //Simulate ECB encryption by using IV of the data.
    var blockCount = data.byteLength / 16;
    var blockPromises = new Array(blockCount);
    for (var i = 0; i < blockCount; i++) {
      var block = data.subarray(i * 16, i * 16 + 16);
      blockPromises[i] = (function(iv) {
        return aes_cbc_rounds(iv, rawKey, rounds);
      })(block);
    }
    return Promise.all(blockPromises).then(function(blocks) {
      //we now have the blocks, so chain them back together
      var result = new Uint8Array(data.byteLength);
      for (var i = 0; i < blockCount; i++) {
        result.set(blocks[i], i * 16);
      }
      return result;
    });
  }

  /*
	* Performs rounds of CBC encryption on data using rawKey
  */
  function aes_cbc_rounds(data, rawKey, rounds) {
  	if (rounds == 0) {
  		//just pass back the current value
  		return data;
  	} else if (rounds > 0xFFFF) {
  		//limit memory use to avoid chrome crash:
  		return aes_cbc_rounds_single(data, rawKey, 0xFFFF).then(function(result) {
  			return aes_cbc_rounds(result, rawKey, rounds - 0xFFFF);
  		});
  	} else {
  		//last iteration, or only iteration if original rounds was low:
  		return aes_cbc_rounds_single(data, rawKey, rounds);
  	}
  }

  function aes_cbc_rounds_single(data, rawKey, rounds) {
    var AES = {
      name: "AES-CBC",
      iv: data
    };
    return window.crypto.subtle.importKey("raw", rawKey, AES, false, ["encrypt"]).then(function(secureKey) {
      var fakeData = new Uint8Array(rounds * 16);
      return window.crypto.subtle.encrypt(AES, secureKey, fakeData);
    }).then(function(result) {
      return new Uint8Array(result, (rounds - 1) * 16, 16);
    });
  }

  function convertArrayToUUID(arr) {
  	var int8Arr = new Uint8Array(arr);
  	var result = new Array(int8Arr.byteLength * 2);
  	for (var i=0;i<int8Arr.byteLength;i++) {
  		result[i * 2] = int8Arr[i].toString(16).toUpperCase();
  	}
  	return result.join("");
  }

  return my;
}
