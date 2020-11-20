(function() {

  // mnemonics is populated as required by getLanguage
  var mnemonics = { "english": new Mnemonic("english") };
  var mnemonic = mnemonics["english"];
  var seed = null;
  var bip32RootKey = null;
  var bip32ExtendedKey = null;
  var network = bitcoin.networks.bitcoin;

  var phraseChangeTimeoutEvent = null;

  var DOM = {};
  DOM.phrase = $(".phrase");
  DOM.start = $(".start");
  DOM.disclaimer = $(".disclaimer");
  DOM.feedback = $(".feedback");
  DOM.pending = $(".pending");
  DOM.progress = $(".progress");

  var progressLog = "";

  // Most mistakes happen in the middle of the phrase, so we start replacing words in the middle and move out.  
  var testOrder = [6, 7, 5, 8, 4, 9, 3, 10, 2, 11, 1, 12];
  
  var n = { // universal counters
    test: 0, // which test position we are swapping words for
    word: 0, // which word we're swapping
    phrase: 0, // which phrase we are calculating an address for
    batch: 0, // which batch we are looking up via api
    batchaddr: 0, // how many addresses have been batched through api
    singleaddr: 0, // how many addresses have been individually checked through api
    totalsingleaddr: 0 // how many total lookups will we need to do
  }

  // What the user has for their phrase, what language it's in, the word list for that language  
  var existingPhrase, language, words;
  
  var errorCount = 0;
  var processTimer = 0;
  var apiTimer = 0;

  function init() {
    // Events
    DOM.phrase.on("input", delayedPhraseChanged);
    DOM.start.on("click", startClicked);
    DOM.disclaimer.change(disclaimed);

    DOM.phrase.focus(function(){
        if($(this).val() == "Enter your phrase here.") $(this).val("");
      }).blur(function(){
        if($(this).val() == "")$(this).val("Enter your phrase here.");
      });
    hidePending();
    hideValidationError();
  }

  // Event handlers

  function disclaimed() {
    if (DOM.disclaimer.is(':checked')) {
      DOM.disclaimer.attr("disabled", true);
      DOM.phrase.attr("readOnly", false);
      DOM.phrase.val("Enter your phrase here.");
      DOM.start.removeClass("greyed").addClass("start-btn");
    }
  }

  function delayedPhraseChanged() {
    hideValidationError();
    showPending();
    if (phraseChangeTimeoutEvent != null) {
      clearTimeout(phraseChangeTimeoutEvent);
    }
    phraseChangeTimeoutEvent = setTimeout(phraseChanged, 400);
  }

  function phraseChanged() {
    showPending();
    hideValidationError();
    setMnemonicLanguage();
    // Get the mnemonic phrase
    var errorText = findPhraseErrors(DOM.phrase.val().toLowerCase());
    if (errorText) {
      showValidationError(errorText);
      return;
    }
    hidePending();
  }

  function startClicked(event) {
    event.preventDefault();

    if (status == 0) {
      startRecovery();
    } else {
      stopRecovery();
    }
  }

// Button actions

  function startRecovery() {
    var validated = findPhraseErrors(DOM.phrase.val().toLowerCase());    
    if (validated != false) {
      showValidationError(validated);
      return;
    }

    progressLog = "";
    status = 1;

    DOM.start.text("Stop");
    DOM.start.removeClass("start-btn").addClass("stop-btn");
    DOM.phrase.attr("readOnly", true);
    addProgress("Generating possible combinations...");
    addProgress("Progress:");
    
    existingPhrase = phraseToWordArray(mnemonic.normalizeString(DOM.phrase.val().toLowerCase()));
    language = getLanguage();
    words = WORDLISTS[language];

    startTime();
    runRecovery();
  }

  function stopRecovery() {
    if (status == 5) {
      DOM.progress.removeClass("success fail");
      progressLog = "";
      DOM.progress.html("");
    } else {
      batches = [[]];
      possiblePhrases = [];
      addProgress("Aborted.");
    }
 
    status = 0;
    n = { test: 0, word: 0, phrase: 0, batch: 0, singleaddr: 0 }

    DOM.phrase.attr("readOnly", false);
    DOM.start.text("Start");
    DOM.start.removeClass("stop-btn").addClass("start-btn");
  }

  // Process management
  // Time-consuming loops can completely lock up the browser, so we use timeouts to break up each loop into segments and give the browser time to do other things in between. 
  // At the end of each segment, call runRecovery with settimeout, and based on the global "status" runRecovery will call the next segment to run.
  
  /*
   * Status:
   *    0 Stopped
   *    1 Calculating phrases
   *    2 Calculating addresses / Sending batches to API
   *    3 Finished calculating addresses / Continue sending batches to API
   *    4 Done.
   */
  
  var status = 0;

  function runRecovery() {
    switch (status) {
      case 0:
        break;
      case 1:
        generatePhrases();
        break;
      case 2:
        calculateAddresses();
        if ((new Date() - apiTimer) > 10000) {
          apiTimer = new Date();
          checkAddressBatch();
        }
        break;
      case 3:
        if ((new Date() - apiTimer) > 10000) {
          apiTimer = new Date();
          checkAddressBatch();
          updateProgress("Waiting for scan to complete, please wait... (" + ((batches.length-1) * 10) + " seconds remaining)");
        }
        break;
      case 4:
        break;
    }
    setTimeout(runRecovery, 0);
  }

  // Recovery methods
  //
  // 1. Generate all possible phrases given the entered information
  // 2. Calculate the first address for each phrase. If a phrase has been used before, it's first
  // address will have a history
  // 3. Check address batches for a batch that includes an address with a history.
  
  var possiblePhrases = [];

  function generatePhrases() {
    
    if (n.word >= words.length) {
      n.test++;
      n.word = 0;
    }
    
    if (n.test >= testOrder.length) {
      // All phrases generated
      status = 2;

      updateProgress("Progress: 24576 / 24576 (Took " + parseTime(stopTime()) + ")");

      addProgress("Found " + possiblePhrases.length + " possibilities.");
      addProgress("Checking the blockchain for existing wallets...")
      addProgress("Progress:");
    
      startTime();
      return;
    }
    
    var toReplace = testOrder[n.test] - 1;

    for (; n.word < words.length; n.word++) {
      var testPhrase = [];

      // Generate phrase to test...

      if (existingPhrase.length == 11) {
       // If 11 words present
        for (var i = 0; i < 12; i++) {
          if (i < toReplace) {
            testPhrase.push(existingPhrase[i]);
          } else if (i > toReplace) {
            testPhrase.push(existingPhrase[i - 1]);
          } else {
            testPhrase.push(words[n.word]);
          }
        }

      } else {
        // If 12 words present
        for (var i = 0; i < 12; i++) {
          if (i == toReplace) {
            testPhrase.push(words[n.word]);
          } else {
            testPhrase.push(existingPhrase[i]);
          }
        }
      }      

      testPhrase = wordArrayToPhrase(testPhrase, language);

      // Check validity
      var isValid = mnemonic.check(testPhrase);

      if (isValid) {
        // Add possibility
        possiblePhrases.push(testPhrase);
      }

      if (n.word % 100 == 0) {
        var done = (n.word + (n.test * 2048));
        updateProgress("Progress: " + done + " / 24576");
        n.word++
        break;
      }
    }
  }

  var batches = [[]];
  
  function calculateAddresses() {
    if (n.phrase >= possiblePhrases.length) {
      // Finished calculating addresses. Just waiting on api callbacks.
      status = 3;
      updateProgress("Progress: " + possiblePhrases.length + " / " + possiblePhrases.length + " (Took " + parseTime(stopTime()) + ")");
      addProgress("Waiting for scan to complete, please wait...")
      return;
    }

    // Create batches of 100 addresses
    if (batches[batches.length - 1].length >= 101) {
      console.log("Starting new batch");
      batches.push([]);
    }

    calcBip32RootKeyFromSeed(possiblePhrases[n.phrase], "");
    calcBip32ExtendedKey("m/0'/0");

    var key = bip32ExtendedKey.derive(0);

    batches[batches.length - 1].push({ address: key.getAddress().toString(), phrase: possiblePhrases[n.phrase] });
          
    updateProgress("Progress: " + n.phrase + " / "+ possiblePhrases.length + " (" + timeLeft(n.phrase, possiblePhrases.length - n.phrase) + " remaining)");
    n.phrase++;
  }
  
  function checkAddressBatch() {

    if (status < 2) return;
    
    // If no batches are ready yet, wait
    if (batches.length < 2 && status != 3) {      
      return;
    } 
    
    var addressList = "";
    var phraseList = {};

    var b = batches[0];

    for (var i = 0; i < b.length; i++) {
      var n = b[i];
      addressList += n.address;
      if (i < b.length - 1) addressList += ",";
      phraseList[n.address] = n.phrase;
    }
      
    fetch("https://blockchain.info/multiaddr?n=1&cors=true&active=" + addressList)
    .then((resp) => resp.json())
    .then(function (data) {
      var a = data.addresses
      for (var i = 0; i < a.length; i++) {
        var n = a[i]
        if (n.total_received > 0) {
          // We got a match!
          status = 4;
          succeed(phraseList[n.address]);
          return;
        }
      }

      // No hits
      console.log("Got no hits.");
      if (status == 3 && batches.length <= 1) {
        fail();
      } else {
        batches.shift();
      }
  
    })
    .catch(function (error) {
      console.log(error)
      errorCount++;
      if (errorCount > 4) {
        showValidationError("Connectivity errors. Please try again later.");
        stopRecovery();
      } else {
        apiTimer = new Date() - 5000;
      }
    });  
  }

  // Graphical

  function showValidationError(errorText) {
    hidePending();
    DOM.feedback
      .text(errorText)
      .show();
  }

  function hideValidationError() {
    DOM.feedback
      .text("")
      .hide();
  }

  function showPending() {
    hideValidationError();
    DOM.pending
      .text("Checking...")
      .show();
  }

  function hidePending() {
    DOM.pending
      .text("")
      .hide();
  }

  // Address generation and other tools

  function calcBip32RootKeyFromSeed(phrase, passphrase) {
    seed = mnemonic.toSeed(phrase, passphrase);
    bip32RootKey = bitcoin.HDNode.fromSeedHex(seed, network);
  }

  function calcBip32ExtendedKey(path) {
    bip32ExtendedKey = bip32RootKey;
    // Derive the key from the path
    var pathBits = path.split("/");
    for (var i=0; i<pathBits.length; i++) {
      var bit = pathBits[i];
      var index = parseInt(bit);
      if (isNaN(index)) {
        continue;
      }
      var hardened = bit[bit.length-1] == "'";
      if (hardened) {
        bip32ExtendedKey = bip32ExtendedKey.deriveHardened(index);
      }
      else {
        bip32ExtendedKey = bip32ExtendedKey.derive(index);
      }
    }
  }

  function findPhraseErrors(phrase) {
    // Preprocess the words
    phrase = mnemonic.normalizeString(phrase);
    var words = phraseToWordArray(phrase);
    
    // Check each word
    for (var i=0; i<words.length; i++) {
      var word = words[i];
      var language = getLanguage();
      if (WORDLISTS[language].indexOf(word) == -1) {
        console.log("Finding closest match to " + word);
        var nearestWord = findNearestWord(word);
        return '"' + word.charAt(0).toUpperCase() + word.slice(1) + '" is not a valid word. Did you mean "' + nearestWord + '"?';
      }
    }

    if ((words.length < 11 || words.length > 12) && words.length != 0) return "Must have 11 or 12 words of phrase.";
    
    return false;
  }

  function findNearestWord(word) {
    var language = getLanguage();
    var words = WORDLISTS[language];
    var minDistance = 99;
    var closestWord = words[0];
    for (var i=0; i<words.length; i++) {
      var comparedTo = words[i];
      var distance = Levenshtein.get(word, comparedTo);
      if (distance < minDistance) {
        closestWord = comparedTo;
        minDistance = distance;
      }
    }
    return closestWord;
  }

  function getLanguage() {
    var defaultLanguage = "english";
    // Try to get from existing phrase
    var language = getLanguageFromPhrase();
    // Default to English if no other option
    return language.length == 0 ? defaultLanguage : language;
  }

  function getLanguageFromPhrase(phrase) {
    // Check if how many words from existing phrase match a language.
    var language = "";
    if (!phrase) {
      phrase = DOM.phrase.val();
    }
    if (phrase.length > 0) {
      var words = phraseToWordArray(phrase);
      var languageMatches = {};
      for (l in WORDLISTS) {
        // Track how many words match in this language
        languageMatches[l] = 0;
        for (var i=0; i<words.length; i++) {
          var wordInLanguage = WORDLISTS[l].indexOf(words[i]) > -1;
          if (wordInLanguage) {
            languageMatches[l]++;
          }
        }
        // Find languages with most word matches.
        // This is made difficult due to commonalities between Chinese
        // simplified vs traditional.
        var mostMatches = 0;
        var mostMatchedLanguages = [];
        for (var l in languageMatches) {
          var numMatches = languageMatches[l];
          if (numMatches > mostMatches) {
            mostMatches = numMatches;
            mostMatchedLanguages = [l];
          }
          else if (numMatches == mostMatches) {
            mostMatchedLanguages.push(l);
          }
        }
      }
      if (mostMatchedLanguages.length > 0) {
        // Use first language and warn if multiple detected
        language = mostMatchedLanguages[0];
        if (mostMatchedLanguages.length > 1) {
          console.warn("Multiple possible languages");
          console.warn(mostMatchedLanguages);
        }
      }
    }
    return language;
  }

  function setMnemonicLanguage() {
    var language = getLanguage();
    // Load the bip39 mnemonic generator for this language if required
    if (!(language in mnemonics)) {
      mnemonics[language] = new Mnemonic(language);
    }
    mnemonic = mnemonics[language];
  }

  function phraseToWordArray(phrase) {
    var words = phrase.split(/\s/g);
    var noBlanks = [];
    for (var i=0; i<words.length; i++) {
      var word = words[i];
      if (word.length > 0) {
        noBlanks.push(word);
      }
    }
    return noBlanks;
  }

  function wordArrayToPhrase(words, language) {
    var phrase = words.join(" ");
    if (typeof language == "undefined") language = getLanguageFromPhrase(phrase);
    if (language == "japanese") {
      phrase = words.join("\u3000");
    }
    return phrase;
  }

  // Output-related

  function addProgress(text) {
    progressLog += text + "<br>";
    DOM.progress.html(progressLog);
  }

  function updateProgress(text) {
    var old =progressLog.substring(0,progressLog.lastIndexOf("<br>", progressLog.length - 5));
    progressLog = old + "<br>" + text + "<br>";
    DOM.progress.html(progressLog);
  }

  function timeLeft(done, remain) {
    var soFar = Math.round(new Date() / 1000) - processTimer;
    var left = Math.round((soFar / done) * remain);
    return parseTime(left);    
  }

  function parseTime(total) {
    var min = Math.floor(total / 60);
    var sec = total - (min * 60); 
    if (min > 0) {
      return min + " minutes";
    } else {
      return sec + " seconds";
    }
  }

  function startTime() {
    processTimer = Math.round(new Date() / 1000);
  }

  function stopTime() {
    return Math.round((new Date() / 1000)) - processTimer;
  }

  function calcSplitTimes(items) {
    var splits = 0;
    while (items > 1) {
      items = Math.floor(items / 2);
      splits++;
    }
    return splits;
  }

  function comparePhraseForDisplay(phrase) {
    var wordArray = phraseToWordArray(phrase);
    for (var i = 0; i < wordArray.length; i++) { 
      if (wordArray[i] != existingPhrase[i]) {
        wordArray[i] = '<span class="missingWord">' + wordArray[i] + '</span>';
        break;
      }
    }
    wordArray[6] = '<br>' + wordArray[6];
    return wordArray.join(" ");
  }

  function succeed(phrase) {
    status = 4;
    DOM.start.text("Reset");

    DOM.progress.addClass("success");
    progressLog = '<div>Success! Your correct phrase is below: <br></div>' +
      '<div class="foundPhrase">' + comparePhraseForDisplay(phrase) + '</div>' +
      '<div class="donation-box">If you found this tool helpful, please consider making a donation to ' +
      '<a href="bitcoin://34Nzz1xdh3FAGPoaDzFwiuSUzuTAHgA2Nr">34Nzz1xdh3FAGPoaDzFwiuSUzuTAHgA2Nr</a> ➠</div>' +
      '<img src="images/qr_code.jpg" class="donation-image">';
    
    DOM.progress.html(progressLog);
  }

  function fail() {
    status = 5;
    DOM.start.text("Reset");
    DOM.progress.addClass("fail");
    addProgress('<br><br><span class="foundPhrase">Unfortunately, no valid phrase was found.</span>');
  }

  init();

})();
